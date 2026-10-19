import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { AgentPoolBroker } from "./agent-pool-broker.js";
import type { AdapterExecutionContext } from "../adapters/types.js";

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });

function context(runId = randomUUID(), companyId = "company-a"): AdapterExecutionContext {
  return {
    runId, agent: { id: "agent", name: "Agent", companyId, adapterType: "agent_pool", adapterConfig: {} },
    config: { name: "default" }, context: { task: "Make a useful change" },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    onLog: vi.fn(async () => {}), onDispatch: vi.fn(), onCancellationReady: vi.fn(async () => {}),
  };
}

async function harness(reconnectMs = 1000) {
  const broker = new AgentPoolBroker(reconnectMs);
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  const port = address.port;
  server.on("connection", (socket, req) => {
    const id = new URL(req.url!, "http://localhost").searchParams.get("id")!;
    broker.attach({ id, companyId: "company-a", poolName: "default" }, socket);
  });
  resources.push(async () => {
    broker.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function worker(id = randomUUID(), instanceId = randomUUID(), runId: string | null = null, ready = true, capabilities: string[] = ["skill_bundle_v1"]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}?id=${id}`);
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    await once(socket, "open");
    const send = (value: object) => socket.send(JSON.stringify(value));
    send({ type: "hello", protocolVersion: 1, instanceId, runId, capabilities });
    await vi.waitFor(() => expect(messages.length || socket.readyState === WebSocket.CLOSED).toBeTruthy());
    const welcome = messages.shift();
    if (welcome && !runId && ready) {
      send({ type: "ready" });
      await vi.waitFor(() => expect(broker.status(id)).toBe("idle"));
    }
    return {
      id, instanceId, socket, messages, send, welcome,
      async take(type: string) {
        await vi.waitFor(() => expect(messages.some((message) => message.type === type)).toBe(true));
        return messages.splice(messages.findIndex((message) => message.type === type), 1)[0]!;
      },
      async disconnect() {
        socket.terminate();
        await once(socket, "close");
        await vi.waitFor(() => expect(broker.status(id)).toBe("reconnecting"));
      },
    };
  }
  return { broker, worker };
}

describe("AgentPool execution channel", () => {
  it("allows the same pool worker to serve different agents on successive assignments", async () => {
    const { broker, worker } = await harness();
    const client = await worker();
    for (const agentId of ["first-agent", "second-agent", "first-agent"]) {
      const ctx = context();
      ctx.agent.id = agentId;
      const result = broker.execute(ctx);
      expect(await client.take("task")).toMatchObject({ agent: { id: agentId }, runId: ctx.runId });
      client.send({ type: "result", runId: ctx.runId, seq: 1, exitCode: 0 });
      await result;
      await client.take("ack");
      client.send({ type: "ready" });
      await vi.waitFor(() => expect(broker.status(client.id)).toBe("idle"));
    }
  });

  it("does not dispatch any assignment to a worker without skill integrity support", async () => {
    const { broker, worker } = await harness();
    const legacy = await worker(randomUUID(), randomUUID(), null, true, []);
    const ctx = context();
    await expect(broker.execute(ctx)).rejects.toThrow("skill_bundle_v1");
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(legacy.messages).toEqual([]);
    expect(broker.status(legacy.id)).toBe("idle");
  });

  it("requires inline capability, selects a compatible worker, and sends one bounded instruction snapshot", async () => {
    const { broker, worker } = await harness();
    const legacy = await worker();
    const ctx = context();
    const instructions = {
      version: 1, format: "markdown", content: "Agent-specific operating instructions",
      revisionId: "saved-revision", contentSha256: createHash("sha256").update("Agent-specific operating instructions").digest("hex"),
    };
    ctx.context.paperclipAgentInstructions = instructions;
    await expect(broker.execute(ctx)).rejects.toThrow("inline_instructions_v1");
    expect(legacy.messages).toEqual([]);
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    const compatible = await worker(randomUUID(), randomUUID(), null, true, ["inline_instructions_v1", "skill_bundle_v1", "future_extension"]);
    const result = broker.execute(ctx);
    const task = await compatible.take("task");
    expect(task).toMatchObject({
      protocolVersion: 1, agent: { id: ctx.agent.id, companyId: ctx.agent.companyId }, instructions,
      skills: { version: 1, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(task.context).not.toHaveProperty("paperclipAgentInstructions");
    instructions.content = "A subsequent edit";
    expect(task.instructions).toMatchObject({ content: "Agent-specific operating instructions" });
    expect(legacy.messages).toEqual([]);
    compatible.send({ type: "result", runId: ctx.runId, seq: 1, exitCode: 0 });
    await result;
  });

  it("rejects oversized instructions without reserving or dispatching the worker", async () => {
    const { broker, worker } = await harness();
    const client = await worker(randomUUID(), randomUUID(), null, true, ["inline_instructions_v1", "skill_bundle_v1"]);
    const ctx = context();
    ctx.context.paperclipAgentInstructions = {
      version: 1, format: "markdown", content: "x".repeat(256 * 1024),
      revisionId: "large-revision", contentSha256: "a".repeat(64),
    };
    await expect(broker.execute(ctx)).rejects.toThrow("256 KiB frame limit");
    expect(broker.status(client.id)).toBe("idle");
    expect(ctx.onDispatch).not.toHaveBeenCalled();
    expect(client.messages).toEqual([]);
  });

  it("checks company-scoped pool readiness while idle or busy, but not during handshake or reconnect", async () => {
    const { broker, worker } = await harness();
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(false);
    const client = await worker(randomUUID(), randomUUID(), null, false);
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(false);
    client.send({ type: "ready" });
    await vi.waitFor(() => expect(broker.hasConnectedWorker("company-a", "default")).toBe(true));
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(true);
    expect(broker.hasConnectedWorker("company-b", "default")).toBe(false);
    expect(broker.hasConnectedWorker("company-a", "other")).toBe(false);
    const ctx = context();
    const result = broker.execute(ctx);
    await client.take("task");
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(true);
    await client.disconnect();
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(false);
    const resumed = await worker(client.id, client.instanceId, ctx.runId);
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(true);
    resumed.send({ type: "result", runId: ctx.runId, seq: 1, exitCode: 0 });
    await result;
    broker.revoke(client.id);
    expect(broker.hasConnectedWorker("company-a", "default")).toBe(false);
  });

  it("fails offline, isolates companies, and assigns each run to exactly one idle worker", async () => {
    const { broker, worker } = await harness();
    await expect(broker.execute(context())).rejects.toThrow("no available");
    const first = await worker();
    const second = await worker();
    await expect(broker.execute(context(randomUUID(), "company-b"))).rejects.toThrow("no available");
    const one = context();
    const two = context();
    const results = [broker.execute(one), broker.execute(two)];
    await expect(broker.execute(context())).rejects.toThrow("no available");
    const tasks = await Promise.all([first.take("task"), second.take("task")]);
    expect(new Set(tasks.map((task) => task.runId))).toEqual(new Set([one.runId, two.runId]));
    expect(one.onDispatch).toHaveBeenCalledOnce();
    for (const [index, client] of [first, second].entries()) {
      client.send({ type: "result", runId: tasks[index]!.runId, seq: 1, exitCode: 0 });
    }
    expect((await Promise.all(results)).map((result) => result.exitCode)).toEqual([0, 0]);
  });

  it("resumes sequenced output without replaying the task or duplicating logs", async () => {
    const { broker, worker } = await harness();
    const first = await worker();
    const ctx = context();
    const result = broker.execute(ctx);
    await first.take("task");
    first.send({ type: "log", runId: ctx.runId, seq: 1, stream: "stdout", data: "before" });
    await first.take("ack");
    await first.disconnect();
    const resumed = await worker(first.id, first.instanceId, ctx.runId);
    expect(resumed.welcome).toMatchObject({ type: "welcome", runId: ctx.runId, ack: 1 });
    resumed.send({ type: "log", runId: ctx.runId, seq: 1, stream: "stdout", data: "before" });
    await resumed.take("ack");
    resumed.send({ type: "log", runId: ctx.runId, seq: 2, stream: "stderr", data: "after" });
    await resumed.take("ack");
    resumed.send({ type: "result", runId: ctx.runId, seq: 3, exitCode: 1, error: "model failed" });
    await expect(result).resolves.toMatchObject({ exitCode: 1, errorMessage: "model failed" });
    expect(ctx.onLog).toHaveBeenCalledTimes(2);
    expect(resumed.messages.some((message) => message.type === "task")).toBe(false);
  });

  it("retains a completed result until ready, including a lost final acknowledgement", async () => {
    const { broker, worker } = await harness();
    const first = await worker();
    const ctx = context();
    const result = broker.execute(ctx);
    await first.take("task");
    first.send({ type: "result", runId: ctx.runId, seq: 1, exitCode: 0 });
    await result;
    await first.disconnect();
    const resumed = await worker(first.id, first.instanceId, ctx.runId);
    expect(resumed.welcome).toMatchObject({ ack: 1, completed: true, runId: ctx.runId });
    resumed.send({ type: "ready" });
    await vi.waitFor(() => expect(broker.status(first.id)).toBe("idle"));
    expect(resumed.messages.some((message) => message.type === "task")).toBe(false);
  });

  it("fails a run when its worker process restarts, without replay", async () => {
    const { broker, worker } = await harness();
    const first = await worker();
    const result = broker.execute(context());
    const rejection = expect(result).rejects.toThrow("process restarted");
    await first.take("task");
    await first.disconnect();
    const replacement = await worker(first.id);
    await rejection;
    expect(replacement.messages.some((message) => message.type === "task")).toBe(false);
  });

  it("fails an expired reconnect lease and rejects execution adoption after server loss", async () => {
    const { broker, worker } = await harness(30);
    const first = await worker();
    const ctx = context();
    const result = broker.execute(ctx);
    const rejected = expect(result).rejects.toThrow("lease expired");
    await first.take("task");
    first.socket.terminate();
    await rejected;
    const stale = await worker(first.id, first.instanceId, ctx.runId);
    expect(stale.welcome).toBeUndefined();
    expect(stale.messages).toEqual([]);
  });

  it("does not settle cancellation until the worker reports its stopped execution", async () => {
    const { broker, worker } = await harness();
    const client = await worker();
    const controller = new AbortController();
    const ctx = { ...context(), signal: controller.signal };
    let settled = false;
    const result = broker.execute(ctx).finally(() => { settled = true; });
    await client.take("task");
    controller.abort();
    expect(await client.take("cancel")).toMatchObject({ runId: ctx.runId });
    expect(settled).toBe(false);
    client.send({ type: "result", runId: ctx.runId, seq: 1, exitCode: 130 });
    await expect(result).resolves.toMatchObject({ exitCode: 130 });
    expect(ctx.onCancellationReady).toHaveBeenCalledOnce();
  });

  it("surfaces log persistence failures and rejects stale sequence numbers", async () => {
    const { broker, worker } = await harness();
    const client = await worker();
    const ctx = context();
    const result = broker.execute(ctx);
    const rejected = expect(result).rejects.toThrow("sequence mismatch");
    await client.take("task");
    client.send({ type: "result", runId: ctx.runId, seq: 2, exitCode: 0 });
    await rejected;
    expect(ctx.onLog).not.toHaveBeenCalled();
  });
});
