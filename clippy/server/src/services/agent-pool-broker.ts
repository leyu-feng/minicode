import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  AGENT_POOL_INLINE_INSTRUCTIONS, AGENT_POOL_PROTOCOL_VERSION, AGENT_POOL_SKILL_BUNDLE, AGENT_POOL_FRAME_512K,
  AGENT_POOL_HOSTED_REPOSITORIES,
  AGENT_POOL_HOSTED_WORKSPACE,
  AGENT_POOL_GITHUB_CREDENTIAL, agentPoolGitHubCredentialSchema, agentPoolRequiresGitHubLogin, type AgentPoolGitHubCredential,
  AGENT_POOL_GIT_IDENTITY, agentPoolGitIdentitySchema, type AgentPoolGitIdentity,
  AGENT_POOL_PR_INSPECTOR, type AgentPoolPrPolicy,
  PR_INSPECTION_RESULT_SCHEMA,
  agentPoolHelloSchema, agentPoolInstructionsSchema, agentPoolNameSchema, agentPoolTaskSchema,
  agentPoolHarnessIdSchema,
  AGENT_POOL_CLAUDECODE_DEFAULT_MODEL,
  AGENT_POOL_TOOL_DETAILS, AGENT_POOL_TRANSCRIPT_DETAILS, runToolDetailSchema,
} from "@paperclipai/shared";
import type { AdapterExecutionContext, AdapterExecutionResult } from "../adapters/types.js";
import { readAgentPoolSkills } from "./agent-pool-skills.js";
import { AGENT_POOL_STOP_SCHEMA } from "./agent-pool-execution-stop.js";

export const AGENT_POOL_RECONNECT_MS = 60_000;
export const AGENT_POOL_MAX_FRAME = 512 * 1024;
const MAX_RUN_OUTPUT = 2 * 1024 * 1024;
const readySchema = z.object({ type: z.literal("ready"), retiring: z.boolean().optional() });
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool_detail"), runId: z.string(), seq: z.number().int().positive(),
    detail: runToolDetailSchema,
  }),
  z.object({
    type: z.literal("log"), runId: z.string(), seq: z.number().int().positive(),
    stream: z.enum(["stdout", "stderr"]), data: z.string().max(16_384),
  }),
  z.object({
    type: z.literal("result"), runId: z.string(), seq: z.number().int().positive(),
    exitCode: z.number().int().min(0).max(255), error: z.string().max(2000).optional(),
    summary: z.string().max(24000).optional(),
  }),
]);

interface WorkerIdentity { id: string; companyId: string; poolName: string; executionId?: string | null }
interface Run {
  id: string;
  seq: number;
  bytes: number;
  detailBytes?: number;
  cancelled: boolean;
  completed: boolean;
  result?: AdapterExecutionResult;
  completionTimer?: ReturnType<typeof setTimeout>;
  ctx: AdapterExecutionContext;
  resolve: (result: AdapterExecutionResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}
interface Peer {
  identity: WorkerIdentity;
  instanceId: string;
  socket: WebSocket | null;
  ready: boolean;
  capabilities: string[];
  run: Run | null;
  expiry?: ReturnType<typeof setTimeout>;
  reservedRunId?: string;
  retiring?: boolean;
}

export type AgentPoolWorkerRequest = Pick<AdapterExecutionContext, "runId" | "agent" | "config" | "context">;

export class AgentPoolCapacityWaitError extends Error {
  constructor() {
    super("Waiting for a connected, compatible AgentPool worker");
    this.name = "AgentPoolCapacityWaitError";
  }
}

export class AgentPoolBroker {
  readonly serverInstanceId = randomUUID();
  private peers = new Map<string, Peer>();
  private reservations = new Set<string>();
  private deliveries = new Map<string, Promise<void>>();
  private revokedWorkers = new Set<string>();
  prepareExecution?: (ctx: AdapterExecutionContext, options?: { waitForWorker: boolean }) => Promise<void | {
    githubCredential?: AgentPoolGitHubCredential; gitIdentity?: AgentPoolGitIdentity; prPolicy?: AgentPoolPrPolicy;
  }>;

  constructor(private reconnectMs = AGENT_POOL_RECONNECT_MS) {}

  status(workerId: string): "offline" | "idle" | "busy" | "reconnecting" {
    const peer = this.peers.get(workerId);
    if (!peer) return "offline";
    if (!peer.socket) return "reconnecting";
    return peer.ready && !peer.run && !peer.reservedRunId && !peer.retiring
      && peer.socket.readyState === WebSocket.OPEN && this.executionAvailable(peer, "") ? "idle" : "busy";
  }

  connection(workerId: string) {
    const peer = this.peers.get(workerId);
    return peer?.socket?.readyState === WebSocket.OPEN
      ? { instanceId: peer.instanceId, capabilities: [...peer.capabilities] } : null;
  }

  private targetWorkerId(ctx: AgentPoolWorkerRequest) {
    return ctx.config.targetWorkerId === undefined ? undefined : z.string().uuid().parse(ctx.config.targetWorkerId);
  }

  hasConnectedWorker(companyId: string, poolName: string): boolean {
    return [...this.peers.values()].some((peer) =>
      peer.identity.companyId === companyId && peer.identity.poolName === poolName
      && (peer.ready || peer.run !== null) && peer.socket?.readyState === WebSocket.OPEN);
  }

  private requiredCapabilities(ctx: AgentPoolWorkerRequest) {
    const selection = ctx.context.paperclipHostedRepositories;
    const allRepositories = selection !== null && typeof selection === "object"
      && "mode" in selection && selection.mode === "all_repositories";
    const harness = agentPoolHarnessIdSchema.parse(ctx.config.harness ?? "default");
    return [AGENT_POOL_SKILL_BUNDLE, AGENT_POOL_PR_INSPECTOR, PR_INSPECTION_RESULT_SCHEMA,
      ...(harness === "default" ? [] : [`harness_${harness}_v1`]),
      ...(agentPoolRequiresGitHubLogin(harness) ? [AGENT_POOL_GITHUB_CREDENTIAL, AGENT_POOL_GIT_IDENTITY] : []),
      ...(ctx.context.paperclipAgentInstructions ? [AGENT_POOL_INLINE_INSTRUCTIONS] : []),
      ...(selection ? [allRepositories ? AGENT_POOL_HOSTED_WORKSPACE : AGENT_POOL_HOSTED_REPOSITORIES] : [])];
  }

  hasAvailableWorker(ctx: AgentPoolWorkerRequest): boolean {
    const targetWorkerId = this.targetWorkerId(ctx);
    return [...this.peers.values()].some((peer) => peer.identity.companyId === ctx.agent.companyId
      && (targetWorkerId === undefined || peer.identity.id === targetWorkerId)
      && peer.identity.poolName === (ctx.config.name ?? "default") && peer.ready && !peer.run
      && !peer.retiring
      && peer.socket?.readyState === WebSocket.OPEN
      && this.executionAvailable(peer, ctx.runId)
      && this.requiredCapabilities(ctx).every((capability) => peer.capabilities.includes(capability)));
  }

  reserveAvailableWorker(ctx: AgentPoolWorkerRequest): boolean {
    const targetWorkerId = this.targetWorkerId(ctx);
    const reserved = [...this.peers.values()].find(peer => peer.reservedRunId === ctx.runId);
    if (reserved && reserved.identity.companyId === ctx.agent.companyId
      && (targetWorkerId === undefined || reserved.identity.id === targetWorkerId)
      && reserved.identity.poolName === (ctx.config.name ?? "default") && !reserved.retiring && !reserved.run
      && reserved.socket?.readyState === WebSocket.OPEN && this.executionAvailable(reserved, ctx.runId)
      && this.requiredCapabilities(ctx).every(capability => reserved.capabilities.includes(capability))) return true;
    this.releaseReservation(ctx.runId);
    const available = [...this.peers.values()].filter((candidate) => candidate.identity.companyId === ctx.agent.companyId
      && (targetWorkerId === undefined || candidate.identity.id === targetWorkerId)
      && candidate.identity.poolName === (ctx.config.name ?? "default") && candidate.ready && !candidate.run
      && !candidate.retiring
      && candidate.socket?.readyState === WebSocket.OPEN
      && this.executionAvailable(candidate, ctx.runId)
      && this.requiredCapabilities(ctx).every((capability) => candidate.capabilities.includes(capability)));
    const peer = available.find(candidate => candidate.capabilities.includes(AGENT_POOL_FRAME_512K)) ?? available[0];
    if (!peer) return false;
    peer.ready = false;
    peer.reservedRunId = ctx.runId;
    this.reservations.add(ctx.runId);
    return true;
  }

  reservedWorker(runId: string) {
    return [...this.peers.values()].find(peer => peer.reservedRunId === runId)?.identity;
  }

  private executionAvailable(peer: Peer, runId: string) {
    return !peer.identity.executionId || ![...this.peers.values()].some(other =>
      other.identity.executionId === peer.identity.executionId
      && ((other.run && other.run.id !== runId) || (other.reservedRunId && other.reservedRunId !== runId)));
  }

  releaseReservation(runId: string) {
    this.reservations.delete(runId);
    for (const peer of this.peers.values()) {
      if (peer.reservedRunId !== runId) continue;
      delete peer.reservedRunId;
      if (!peer.retiring && !peer.run && peer.socket?.readyState === WebSocket.OPEN) peer.ready = true;
    }
  }

  private send(peer: Peer, value: object) {
    const socket = peer.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(value), (error) => {
      if (error) socket.terminate();
    });
  }

  private fail(peer: Peer, message: string) {
    if (peer.run) {
      peer.run.cleanup();
      peer.run.reject(new Error(message));
    }
    peer.run = null;
    peer.ready = false;
  }

  revoke(workerId: string, message = "AgentPool worker was revoked") {
    this.revokedWorkers.add(workerId);
    this.disconnect(workerId, message);
  }

  reactivate(workerId: string) {
    this.disconnect(workerId, "Hosted worker slot was reassigned to a new credential generation");
    this.revokedWorkers.delete(workerId);
  }

  disconnect(workerId: string, message: string) {
    const peer = this.peers.get(workerId);
    if (!peer) return;
    if (peer.expiry) clearTimeout(peer.expiry);
    this.fail(peer, message);
    peer.socket?.close(1008, message);
    this.peers.delete(workerId);
  }

  close() {
    for (const id of this.peers.keys()) this.disconnect(id, "AgentPool server stopped; retry the run explicitly");
  }

  attach(identity: WorkerIdentity, socket: WebSocket) {
    if (this.revokedWorkers.has(identity.id)) { socket.close(1008, "AgentPool worker was revoked"); return; }
    let peer: Peer | undefined;
    let welcomed = false;
    let pendingBytes = 0;
    const handshakeTimeout = setTimeout(() => socket.close(1008, "AgentPool hello required"), 10_000);
    socket.on("message", (data, binary) => {
      const text = data.toString();
      const bytes = Buffer.byteLength(text);
      pendingBytes += bytes;
      if (pendingBytes > 4 * 1024 * 1024) {
        this.disconnect(identity.id, "AgentPool worker exceeded the pending output limit");
        socket.close(1008, "AgentPool pending output limit exceeded");
        return;
      }
      const delivery = (this.deliveries.get(identity.id) ?? Promise.resolve()).then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (this.revokedWorkers.has(identity.id)) { socket.close(1008, "AgentPool worker was revoked"); return; }
        if (binary) throw new Error("AgentPool expects JSON text");
        const value: unknown = JSON.parse(text);
        if (!welcomed) {
          const hello = agentPoolHelloSchema.parse(value);
          const existing = this.peers.get(identity.id);
          if (existing && existing.instanceId !== hello.instanceId) {
            this.disconnect(identity.id, "AgentPool worker process restarted; retry the run explicitly");
          }
          peer = this.peers.get(identity.id);
          if (peer) {
            if (peer.run?.id !== hello.runId && (peer.run || hello.runId)) {
              this.disconnect(identity.id, "AgentPool execution was lost; tasks are never automatically replayed");
              throw new Error("AgentPool execution no longer exists");
            }
            if (peer.expiry) clearTimeout(peer.expiry);
            peer.socket?.close(1000, "replaced connection");
            peer.socket = socket;
            peer.ready = false;
            peer.retiring = false;
            delete peer.reservedRunId;
          } else {
            if (hello.runId) throw new Error("AgentPool server lost the execution; retry the run explicitly");
            peer = { identity, instanceId: hello.instanceId, socket, ready: false, run: null, capabilities: [] };
            this.peers.set(identity.id, peer);
          }
          peer.capabilities = hello.capabilities;
          welcomed = true;
          clearTimeout(handshakeTimeout);
          this.send(peer, {
            type: "welcome", protocolVersion: AGENT_POOL_PROTOCOL_VERSION, serverInstanceId: this.serverInstanceId,
            capabilities: ["retiring_ready_v1", AGENT_POOL_TOOL_DETAILS, AGENT_POOL_TRANSCRIPT_DETAILS],
            runId: peer.run?.id ?? null, ack: peer.run?.seq ?? 0,
            completed: peer.run?.completed ?? false,
          });
          if (peer.run?.cancelled) this.send(peer, { type: "cancel", runId: peer.run.id });
          return;
        }
        if (!peer || peer.socket !== socket) return;
        const ready = readySchema.safeParse(value);
        if (ready.success) {
          if (peer.run && !peer.run.completed) throw new Error("Worker cannot become idle during a run");
          const run = peer.run;
          peer.run = null;
          peer.retiring = ready.data.retiring === true;
          peer.ready = !ready.data.retiring && !peer.reservedRunId;
          if (run?.result) {
            run.cleanup();
            run.resolve({
              ...run.result,
              resultJson: { agentPoolStop: {
                schema: AGENT_POOL_STOP_SCHEMA,
                runId: run.id, companyId: identity.companyId,
                workerId: identity.id, instanceId: peer.instanceId,
                resultSequence: run.seq, stoppedAt: new Date().toISOString(),
              } },
            });
          }
          if (ready.data.retiring) this.send(peer, { type: "retired" });
          return;
        }
        const event = eventSchema.parse(value);
        const run = peer.run;
        if (!run || event.runId !== run.id) throw new Error("AgentPool run mismatch");
        if (event.seq <= run.seq) {
          this.send(peer, { type: "ack", runId: run.id, seq: run.seq, completed: run.completed });
          return;
        }
        if (event.seq !== run.seq + 1 || run.completed) throw new Error("AgentPool event sequence mismatch");
        if (event.type === "log") {
          run.bytes += Buffer.byteLength(event.data);
          if (run.bytes > MAX_RUN_OUTPUT) throw new Error("AgentPool run exceeded the output limit");
          await run.ctx.onLog(event.stream, event.data);
        } else if (event.type === "tool_detail") {
          run.detailBytes = (run.detailBytes ?? 0) + Buffer.byteLength(JSON.stringify(event.detail));
          if (run.detailBytes > 8 * 1024 * 1024) throw new Error("AgentPool tool detail limit exceeded");
          await run.ctx.onEvent?.({
            eventType: "agent_pool.tool_detail",
            stream: "system",
            level: event.detail.error ? "warn" : "info",
            message: event.detail.summary,
            payload: event.detail,
          });
        } else {
          run.completed = true;
          run.cleanup();
          run.result = {
            exitCode: run.cancelled ? 130 : event.exitCode, signal: null, timedOut: false,
            ...(event.error ? { errorMessage: event.error, errorCode: "agent_pool_worker_error" } : {}),
            summary: run.cancelled ? "AgentPool run cancelled" : event.summary?.trim() || `AgentPool worker ${identity.id} finished`,
          };
          run.completionTimer = setTimeout(() => this.disconnect(identity.id,
            "AgentPool completion was not followed by ready; worker quarantined"), this.reconnectMs);
          run.completionTimer.unref();
        }
        run.seq = event.seq;
        this.send(peer, { type: "ack", runId: run.id, seq: run.seq, completed: run.completed });
      }).catch((error: unknown) => {
        if (peer?.socket === socket && this.peers.get(identity.id) === peer) {
          if (peer.expiry) clearTimeout(peer.expiry);
          this.fail(peer, error instanceof Error ? error.message : "AgentPool protocol failure");
          this.peers.delete(identity.id);
        }
        socket.close(1008, "AgentPool protocol or execution lost; retry explicitly");
      });
      this.deliveries.set(identity.id, delivery);
      void delivery.finally(() => {
        pendingBytes -= bytes;
        if (this.deliveries.get(identity.id) === delivery) this.deliveries.delete(identity.id);
      });
    });
    socket.on("close", () => {
      clearTimeout(handshakeTimeout);
      if (!peer || peer.socket !== socket || this.peers.get(identity.id) !== peer) return;
      peer.socket = null;
      peer.ready = false;
      delete peer.reservedRunId;
      peer.expiry = setTimeout(() => {
        if (peer?.socket || this.peers.get(identity.id) !== peer) return;
        this.disconnect(identity.id, "AgentPool worker reconnect lease expired; retry the run explicitly");
      }, this.reconnectMs);
      peer.expiry.unref();
    });
    socket.on("error", () => socket.terminate());
  }

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const queuedAdmission = this.reservations.has(ctx.runId);
    try {
      return await this.executeRun(ctx, queuedAdmission);
    } finally {
      this.releaseReservation(ctx.runId);
    }
  }

  private async executeRun(ctx: AdapterExecutionContext, queuedAdmission: boolean): Promise<AdapterExecutionResult> {
    const targetWorkerId = this.targetWorkerId(ctx);
    const name = ctx.config.name ?? "default";
    const parsedName = agentPoolNameSchema.safeParse(name);
    if (!parsedName.success || parsedName.data !== name) {
      throw new Error("AgentPool requires a valid pool name");
    }
    await ctx.onCancellationReady?.();
    if (ctx.signal?.aborted) throw new Error("AgentPool run was cancelled before dispatch");
    const instructions = ctx.context.paperclipAgentInstructions == null
      ? null : agentPoolInstructionsSchema.parse(ctx.context.paperclipAgentInstructions);
    const skills = await readAgentPoolSkills();
    const unavailable = (errorMessage: string): AdapterExecutionResult => ({
      exitCode: 1, signal: null, timedOut: false, errorCode: "agent_pool_worker_unavailable", errorMessage,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    });
    let githubCredential: AgentPoolGitHubCredential | undefined;
    let gitIdentity: AgentPoolGitIdentity | undefined;
    let prPolicy: AgentPoolPrPolicy = { inspectorAgentId: null, isInspector: false };
    try {
      const prepared = await this.prepareExecution?.(ctx, { waitForWorker: !queuedAdmission });
      prPolicy = prepared?.prPolicy ?? prPolicy;
      githubCredential = prepared?.githubCredential;
      if (agentPoolRequiresGitHubLogin(ctx.config.harness)) {
        gitIdentity = agentPoolGitIdentitySchema.parse(prepared?.gitIdentity);
        const parsed = agentPoolGitHubCredentialSchema.safeParse(githubCredential);
        if (!parsed.success || parsed.data.agentId !== ctx.agent.id
          || parsed.data.companyId !== ctx.agent.companyId || parsed.data.runId !== ctx.runId
          || Date.parse(parsed.data.expiresAt) <= Date.now() + 45 * 60_000) {
          return unavailable("This agent requires completed GitHub sign-in and a valid assignment access token.");
        }
        githubCredential = parsed.data;
      } else githubCredential = undefined;
    } catch (error) {
      if (ctx.signal?.aborted || error instanceof AgentPoolCapacityWaitError) throw error;
      return unavailable(error instanceof Error ? error.message : "Hosted worker preparation failed");
    }
    if (ctx.signal?.aborted) throw new Error("AgentPool run was cancelled before dispatch");
    const available = [...this.peers.values()].filter((candidate) =>
      candidate.identity.companyId === ctx.agent.companyId && candidate.identity.poolName === name
      && (targetWorkerId === undefined || candidate.identity.id === targetWorkerId)
      && !candidate.retiring && (candidate.ready || candidate.reservedRunId === ctx.runId) && !candidate.run
      && candidate.socket?.readyState === WebSocket.OPEN);
    const eligible = available.filter(candidate => this.executionAvailable(candidate, ctx.runId));
    if (!eligible.length) {
      if (queuedAdmission) throw new AgentPoolCapacityWaitError();
      return unavailable(`AgentPool '${name}' has no available connected worker; connect a worker and retry`);
    }
    const required = this.requiredCapabilities(ctx);
    const compatible = eligible.filter(candidate => required.every(capability => candidate.capabilities.includes(capability)));
    const peer = compatible.find(candidate => candidate.reservedRunId === ctx.runId)
      ?? compatible.find(candidate => candidate.capabilities.includes(AGENT_POOL_FRAME_512K)) ?? compatible[0];
    if (!peer) {
      if (queuedAdmission) throw new AgentPoolCapacityWaitError();
      return unavailable(`AgentPool '${name}' has no available worker supporting ${required.join(", ")}; upgrade or connect a compatible worker and retry`);
    }
    const { paperclipAgentInstructions: _instructions, paperclipHostedRepositories: repositories, ...context } = ctx.context;
    if (ctx.executionContinuation != null) {
      if (isDeepStrictEqual(context.executionContinuation, ctx.executionContinuation))
        delete context.executionContinuation;
      const wake = context.paperclipWake;
      if (wake && typeof wake === "object" && !Array.isArray(wake)
        && "executionContinuation" in wake
        && isDeepStrictEqual(wake.executionContinuation, ctx.executionContinuation)) {
        const { executionContinuation: _wakeContinuation, ...wakeContext } = wake;
        context.paperclipWake = wakeContext;
      }
    }
    const harnessModel = ctx.config.harnessModel
      ?? (ctx.config.harness === "claudecode" ? AGENT_POOL_CLAUDECODE_DEFAULT_MODEL : undefined);
    const task = JSON.stringify(agentPoolTaskSchema.parse({
      type: "task", protocolVersion: AGENT_POOL_PROTOCOL_VERSION, runId: ctx.runId,
      harness: ctx.config.harness ?? "default",
      agent: { id: ctx.agent.id, name: ctx.agent.name, companyId: ctx.agent.companyId },
      instructions, skills,
      context,
      continuation: ctx.executionContinuation ?? null,
      runtimeTools: ctx.runtimeTools ?? null,
      authToken: ctx.authToken ?? null,
      ...(githubCredential ? { githubCredential } : {}),
      ...(gitIdentity ? { gitIdentity } : {}),
      prPolicy,
      ...(harnessModel ? { harnessModel } : {}),
      ...(repositories ? { repositories } : {}),
    }));
    const taskBytes = Buffer.byteLength(task);
    if (taskBytes > AGENT_POOL_MAX_FRAME) throw new Error("AgentPool task exceeds the 512 KiB frame limit; reduce instructions or task context");
    if (taskBytes > 256 * 1024 && !peer.capabilities.includes(AGENT_POOL_FRAME_512K))
      return unavailable(`AgentPool '${name}' requires a worker supporting ${AGENT_POOL_FRAME_512K} for assignments above 256 KiB; upgrade a worker and retry`);
    return new Promise((resolve, reject) => {
      let cancelTimer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (!peer.run || peer.run.completed) return;
        peer.run.cancelled = true;
        this.send(peer, { type: "cancel", runId: ctx.runId });
        cancelTimer = setTimeout(() => this.disconnect(peer.identity.id,
          "AgentPool cancellation was not acknowledged; worker quarantined"), this.reconnectMs);
        cancelTimer.unref();
      };
      delete peer.reservedRunId;
      peer.ready = false;
      const run: Run = {
        id: ctx.runId, seq: 0, bytes: 0, cancelled: false, completed: false, ctx, resolve, reject,
        cleanup: () => {
          ctx.signal?.removeEventListener("abort", cancel);
          if (cancelTimer) clearTimeout(cancelTimer);
          if (run.completionTimer) clearTimeout(run.completionTimer);
        },
      };
      peer.run = run;
      ctx.signal?.addEventListener("abort", cancel, { once: true });
      try {
        ctx.onDispatch?.();
        peer.socket!.send(task, (error) => {
          if (error) peer.socket?.terminate();
        });
      } catch (error) {
        this.fail(peer, error instanceof Error ? error.message : "AgentPool dispatch failed");
      }
    });
  }
}

export const agentPoolBroker = new AgentPoolBroker();
