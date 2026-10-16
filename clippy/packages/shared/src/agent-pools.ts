import { z } from "zod";

export const agentPoolNameSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const createAgentPoolSchema = z.object({ name: agentPoolNameSchema });
export const createAgentPoolWorkerSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const pairAgentPoolWorkerSchema = z.object({
  workerId: z.string().uuid(),
  serverToken: z.string().min(32).max(128),
  clientToken: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface AgentPool {
  id: string;
  companyId: string;
  name: string;
}

export interface AgentPoolWorker {
  id: string;
  poolId: string;
  name: string;
  paired: boolean;
  revoked: boolean;
  status: "offline" | "idle" | "busy" | "reconnecting";
}

export interface AgentPoolPairing {
  workerId: string;
  serverToken: string;
  expiresAt: string;
}
