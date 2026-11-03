import { ManagedIdentityCredential } from "@azure/identity";
import { agents, authUsers, heartbeatRuns, type Db } from "@paperclipai/db";
import { agentPoolGitIdentitySchema, type AgentPoolGitIdentity } from "@paperclipai/shared";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";
import { GitHubDeviceLogin, type GitHubLoginStore } from "./github-device-login.js";

// Use the same public GitHub App as the contained Copilot API proxy.
const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
let credential: ManagedIdentityCredential | undefined;

class AgentGitHubVault implements GitHubLoginStore {
  private readonly origin: string;
  private readonly prefix: string;

  constructor(private readonly companyId: string, private readonly agentId: string) {
    const raw = process.env.PAPERCLIP_AGENT_CREDENTIAL_VAULT_URL;
    if (!raw) throw unprocessable("Per-agent GitHub sign-in requires PAPERCLIP_AGENT_CREDENTIAL_VAULT_URL.");
    if (!URL.canParse(raw)) throw unprocessable("The agent credential vault URL is invalid.");
    const url = new URL(raw);
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.vault\.azure\.net$/i.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
      throw unprocessable("The agent credential vault must be an Azure Key Vault HTTPS origin.");
    }
    this.origin = url.origin;
    this.prefix = `agent-github-${z.string().uuid().parse(companyId).replaceAll("-", "")}-${z.string().uuid().parse(agentId).replaceAll("-", "")}`;
  }

  private async request(key: "credentials" | "device", value?: unknown) {
    const signal = AbortSignal.timeout(15_000);
    credential ??= new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID
      ? { clientId: process.env.AZURE_CLIENT_ID } : {});
    const token = await credential.getToken("https://vault.azure.net/.default", { abortSignal: signal });
    if (!token) throw new Error("Azure Key Vault authentication returned no access token.");
    return guardedRemoteHttpFetch(`${this.origin}/secrets/${this.prefix}-${key}?api-version=7.4`, {
      method: value === undefined ? "GET" : "PUT",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify({
        value: JSON.stringify(value),
        tags: { companyId: this.companyId, agentId: this.agentId, purpose: "agent-github-login" },
      }) }),
    }, {
      allowPrivateNetwork: true,
      error: () => new Error("The agent credential vault could not be reached."),
    });
  }

  async get(key: "credentials" | "device"): Promise<unknown | null> {
    const response = await this.request(key);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The agent credential vault returned HTTP ${response.status}.`);
    }
    const { value } = z.object({ value: z.string().max(25_000) }).parse(await response.json());
    const parsed: unknown = JSON.parse(value);
    return parsed;
  }

  async set(key: "credentials" | "device", value: unknown): Promise<void> {
    const response = await this.request(key, value);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Saving the agent credential in Key Vault failed (HTTP ${response.status}).`);
  }
}

export function agentGitHubAuthService(db: Db) {
  async function withAgent<T>(companyId: string, agentId: string,
    action: (login: GitHubDeviceLogin, assertIdle: (runId?: string) => Promise<void>, vault: AgentGitHubVault) => Promise<T>): Promise<T> {
    return db.transaction(async tx => {
      const [agent] = await tx.select({ adapterType: agents.adapterType }).from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).for("update");
      if (!agent) throw notFound("Agent not found");
      if (agent.adapterType !== "agent_pool") throw badRequest("GitHub harness login requires an AgentPool agent.");
      const clientId = process.env.PAPERCLIP_AGENT_GITHUB_CLIENT_ID ?? DEFAULT_CLIENT_ID;
      if (!/^[a-zA-Z0-9._-]{8,100}$/.test(clientId)) {
        throw unprocessable("The agent GitHub App client ID is invalid.");
      }
      const vault = new AgentGitHubVault(companyId, agentId);
      return action(new GitHubDeviceLogin({ clientId, store: vault }), async runId => {
        const [active] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"), ...(runId ? [ne(heartbeatRuns.id, runId)] : []),
        )).limit(1);
        if (active) throw conflict("GitHub token rotation must wait for this agent's existing assignment to finish.");
      }, vault);
    });
  }

  return {
    status: (companyId: string, agentId: string) => withAgent(companyId, agentId, login => login.status()),
    start: (companyId: string, agentId: string, userId: string | undefined) => withAgent(companyId, agentId, async (login, assertIdle) => {
      await assertIdle();
      const previous = await login.status();
      if (previous.state === "pending") return previous;
      const [user] = userId ? await db.select({ name: authUsers.name, email: authUsers.email })
        .from(authUsers).where(eq(authUsers.id, userId)) : [];
      const parsed = agentPoolGitIdentitySchema.safeParse(user);
      if (!parsed.success) throw unprocessable("GitHub sign-in requires a board user with a valid Git name and email.");
      return login.start(parsed.data);
    }),
    poll: (companyId: string, agentId: string) => withAgent(companyId, agentId, async login => {
      const previous = await login.status();
      const status = previous.state === "pending" ? await login.poll() : previous;
      return { status, completed: previous.state === "pending" && status.state === "connected" };
    }),
    updateIdentity: (companyId: string, agentId: string, identity: AgentPoolGitIdentity) =>
      withAgent(companyId, agentId, async (login, _idle, vault) => {
        const parsed = agentPoolGitIdentitySchema.parse(identity);
        const status = await login.status();
        if (status.state !== "connected" && status.state !== "expired")
          throw conflict("Finish GitHub sign-in before editing its Git identity.");
        const credential = z.object({ state: z.literal("connected") }).passthrough().parse(await vault.get("credentials"));
        await vault.set("credentials", { ...credential, gitIdentity: parsed });
        return { ...status, gitIdentity: parsed };
      }),
    assignmentCredentials: (companyId: string, agentId: string, runId: string) =>
      withAgent(companyId, agentId, async (login, assertIdle) => {
        const token = await login.assignmentToken(() => assertIdle(runId));
        const gitIdentity = (await login.status()).gitIdentity;
        if (!gitIdentity) throw unprocessable("Set this agent's Git name and email in its GitHub sign-in settings before running it.");
        return { githubCredential: { ...token, companyId, agentId, runId }, gitIdentity };
      }),
  };
}
