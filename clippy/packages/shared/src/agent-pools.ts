import { z } from "zod";

export const AGENT_POOL_PROTOCOL_VERSION = 1;
export const AGENT_POOL_INLINE_INSTRUCTIONS = "inline_instructions_v1";
export const AGENT_POOL_SKILL_BUNDLE = "skill_bundle_v1";

export const agentPoolHelloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(AGENT_POOL_PROTOCOL_VERSION).default(AGENT_POOL_PROTOCOL_VERSION),
  instanceId: z.string().uuid(),
  runId: z.string().max(100).nullable(),
  capabilities: z.array(z.string().min(1).max(100)).max(32).default([]),
});

export const agentPoolInstructionsSchema = z.object({
  version: z.literal(1),
  format: z.literal("markdown"),
  content: z.string(),
  revisionId: z.string().min(1).max(200),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AgentPoolInstructions = z.infer<typeof agentPoolInstructionsSchema>;

export const agentPoolSkillsSchema = z.object({
  version: z.literal(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().regex(/^\/api\/agent-pool\/skills\/[a-f0-9]{64}\.zip$/),
  files: z.array(z.object({
    path: z.string().min(1).max(240).refine(value =>
      !/[\\:\x00-\x1f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..")),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(256),
});

export type AgentPoolSkills = z.infer<typeof agentPoolSkillsSchema>;

export const agentPoolTaskSchema = z.object({
  type: z.literal("task"),
  protocolVersion: z.literal(AGENT_POOL_PROTOCOL_VERSION),
  runId: z.string(),
  agent: z.object({ id: z.string(), name: z.string(), companyId: z.string().min(1) }),
  instructions: agentPoolInstructionsSchema.nullable(),
  skills: agentPoolSkillsSchema,
  context: z.record(z.string(), z.unknown()),
  continuation: z.unknown().nullable(),
  runtimeTools: z.unknown().nullable(),
  authToken: z.string().nullable(),
});

export type AgentPoolTask = z.infer<typeof agentPoolTaskSchema>;

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
