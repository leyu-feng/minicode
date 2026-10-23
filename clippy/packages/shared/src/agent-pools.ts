import { z } from "zod";

export const AGENT_POOL_PROTOCOL_VERSION = 1;
export const AGENT_POOL_INLINE_INSTRUCTIONS = "inline_instructions_v1";
export const AGENT_POOL_SKILL_BUNDLE = "skill_bundle_v1";
export const AGENT_POOL_HOSTED_REPOSITORIES = "hosted_repositories_v1";
export const AGENT_POOL_HOSTED_WORKSPACE = "hosted_workspace_v2";

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
  repositories: z.union([z.object({
    primary: z.object({ id: z.string(), name: z.string(), branch: z.string() }),
    references: z.array(z.object({ id: z.string(), name: z.string(), branch: z.string() })),
  }), z.object({
    mode: z.literal("all_repositories"),
    repositories: z.array(z.object({
      id: z.string(), name: z.string(), branch: z.string(), readOnly: z.boolean(),
    })).min(1).max(101),
  })]).optional(),
});

export type AgentPoolTask = z.infer<typeof agentPoolTaskSchema>;

export const agentPoolNameSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const createAgentPoolSchema = z.object({ name: agentPoolNameSchema }).strict();
export const hostedWorkerConfigSchema = z.object({
  apiUrl: z.string().url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.replace(/\/+$/, "").endsWith("/v1/hosted-worker");
  }, "Use an HTTPS URL ending in /v1/hosted-worker, without credentials, a query or a fragment."),
  audience: z.string().trim().min(1).max(500).regex(/^\S+$/),
});
export const hostedWorkerStatusSchema = z.object({
  activeWorkers: z.number().int().nonnegative(),
  provisioningWorkers: z.number().int().nonnegative(),
  isMock: z.boolean(),
  sharedFleet: z.boolean().optional(),
});
export const hostedWorkerRepositorySchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  branch: z.string().min(1).max(200),
  isDefault: z.boolean(),
  readOnly: z.boolean().optional(),
  workspaceMode: z.literal("all_repositories").optional(),
});
export const hostedWorkerRepositoriesSchema = z.array(hostedWorkerRepositorySchema).min(1).max(1000)
  .refine((repos) => new Set(repos.map((repo) => repo.id)).size === repos.length
    && (repos.every(repo => repo.workspaceMode === "all_repositories")
      ? repos.some(repo => repo.name === "AgentAcademy" && repo.readOnly === true)
      : repos.every(repo => repo.workspaceMode === undefined) && repos.filter(repo => repo.isDefault).length === 1),
  "The provider must return a consistent all-repository workspace with read-only AgentAcademy, or a legacy catalog with one default.");
export const hostedWorkerDemandSchema = z.object({ itemsWaiting: z.number().int().min(0).max(2147483646) });
export const hostedAgentRepositoriesSchema = z.object({
  primaryRepositoryId: z.string().min(1).max(200).optional(),
  referenceRepositoryIds: z.array(z.string().min(1).max(200)).max(100).default([]),
}).refine((value) => new Set(value.referenceRepositoryIds).size === value.referenceRepositoryIds.length
  && !value.referenceRepositoryIds.includes(value.primaryRepositoryId ?? ""),
"Primary and reference repositories must be distinct.");
export type HostedWorkerConfig = z.infer<typeof hostedWorkerConfigSchema>;
export type HostedWorkerStatus = z.infer<typeof hostedWorkerStatusSchema>;
export type HostedWorkerRepository = z.infer<typeof hostedWorkerRepositorySchema>;
export const createAgentPoolWorkerSchema = z.object({ name: z.string().trim().min(1).max(100) });
export const pairAgentPoolWorkerSchema = z.object({
  workerId: z.string().uuid(),
  serverToken: z.string().min(32).max(128),
  clientToken: z.string().regex(/^[a-f0-9]{64}$/),
});

export const hostedAgentPoolWorkerSchema = z.object({
  companyId: z.string().uuid(),
  poolId: z.string().uuid(),
  poolName: agentPoolNameSchema,
  workerId: z.string().uuid(),
  clientToken: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  executionId: z.string().uuid().optional(),
  generation: z.string().uuid().optional(),
  activationVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict().refine(input => Boolean(input.executionId) === Boolean(input.generation),
  "Shared Hosted workers require both executionId and generation.");

export const hostedAgentPoolSlotsSchema = z.object({
  companyId: z.string().uuid(),
  poolId: z.string().uuid(),
  poolName: agentPoolNameSchema,
  slots: z.array(z.object({ workerId: z.string().uuid(), name: z.string().regex(/^W(?:0[1-9]|[1-9][0-9])$/) }).strict())
    .length(99).refine(slots => new Set(slots.map(slot => slot.workerId)).size === 99
      && new Set(slots.map(slot => slot.name)).size === 99, "All 99 distinct worker slots are required."),
}).strict();

export interface AgentPool {
  id: string;
  companyId: string;
  name: string;
  type: "devbox" | "hosted";
  hostedApiUrl: string | null;
  hostedAudience: string | null;
  hostedPoolId: string | null;
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
