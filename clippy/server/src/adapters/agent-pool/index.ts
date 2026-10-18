import type { ServerAdapterModule } from "../types.js";
import { agentPoolNameSchema } from "@paperclipai/shared";
import { agentPoolBroker } from "../../services/agent-pool-broker.js";

export const agentPoolAdapter: ServerAdapterModule = {
  type: "agent_pool",
  runtimeToolDelivery: "invocation_context",
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  execute: (ctx) => agentPoolBroker.execute(ctx),
  async testEnvironment(ctx) {
    const name = ctx.config.name ?? "default";
    const parsedName = agentPoolNameSchema.safeParse(name);
    if (!parsedName.success || parsedName.data !== name) {
      return {
        adapterType: "agent_pool", status: "fail", testedAt: new Date().toISOString(),
        checks: [{ code: "agent_pool_name", level: "error",
          message: "AgentPool requires a valid pool name." }],
      };
    }
    const connected = agentPoolBroker.hasConnectedWorker(ctx.companyId, parsedName.data);
    return {
      adapterType: "agent_pool", status: connected ? "pass" : "fail", testedAt: new Date().toISOString(),
      checks: [{ code: "agent_pool_worker", level: connected ? "info" : "error",
        message: connected
          ? `AgentPool '${parsedName.data}' has a connected Minicode worker. Model access is verified when a task runs.`
          : `AgentPool '${parsedName.data}' has no connected worker. Pair and connect a Minicode worker in company settings.` }],
    };
  },
  agentConfigurationDoc: "Select a company AgentPool with adapterConfig: {\"name\":\"default\"}. Pair compatible workers in company settings. Managed agent instructions are delivered inline on every assignment; workers must advertise inline_instructions_v1. Runs fail if no compatible worker is available; disconnected executions can reconnect without replay for 60 seconds.",
};
