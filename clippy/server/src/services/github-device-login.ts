import { z } from "zod";
import type { AgentGitHubLoginStatus } from "@paperclipai/shared";

const MIN_ASSIGNMENT_VALIDITY_MS = 48 * 60_000;
const accountSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1).max(100),
});
const tokenSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(8192),
  refresh_token_expires_in: z.number().int().positive().max(31_536_000),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
});
const credentialSchema = z.object({
  state: z.literal("connected"),
  clientId: z.string().min(1),
  accessToken: z.string().min(1).max(8192),
  expiresAt: z.number().int().positive(),
  refreshToken: z.string().min(1).max(8192),
  refreshExpiresAt: z.number().int().positive(),
  account: accountSchema.optional(),
  signedInAt: z.number().int().positive().optional(),
});
const pendingSchema = z.object({
  state: z.literal("pending"),
  clientId: z.string().min(1),
  deviceCode: z.string().min(1).max(1024),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verificationUri: z.literal("https://github.com/login/device"),
  expiresAt: z.number().int().positive(),
  interval: z.number().int().positive().max(3600),
  nextPollAt: z.number().int().positive(),
});
const storedCredentialsSchema = z.union([
  credentialSchema,
  z.object({ state: z.literal("required") }),
]);
const storedDeviceSchema = z.union([
  pendingSchema,
  z.object({ state: z.enum(["complete", "expired", "denied", "failed"]), message: z.string().max(500) }),
]);

export interface GitHubLoginStore {
  get(key: "credentials" | "device"): Promise<unknown | null>;
  set(key: "credentials" | "device", value: unknown): Promise<void>;
}

type GitHubLoginStatus = AgentGitHubLoginStatus;

export class GitHubLoginRequiredError extends Error {
  readonly code = "agent_github_login_required";
  constructor() {
    super("This agent is blocked until GitHub sign-in is completed in its settings.");
  }
}

export class GitHubDeviceLogin {
  constructor(private readonly options: {
    clientId: string;
    store: GitHubLoginStore;
    fetcher?: typeof fetch;
    now?: () => number;
  }) {}

  private now() { return (this.options.now ?? Date.now)(); }

  private async request(parameters: Record<string, string>, device = false): Promise<unknown> {
    const response = await (this.options.fetcher ?? fetch)(
      `https://github.com/login/${device ? "device/code" : "oauth/access_token"}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.options.clientId, ...parameters }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub sign-in returned HTTP ${response.status}.`);
    }
    return response.json();
  }

  private async credentials() {
    const value = await this.options.store.get("credentials");
    if (value === null) return null;
    const credential = storedCredentialsSchema.parse(value);
    return credential.state === "connected" && credential.clientId === this.options.clientId
      ? credential : null;
  }

  private async account(accessToken: string) {
    const response = await (this.options.fetcher ?? fetch)("https://api.github.com/user", {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Paperclip-Agent-GitHub-Login",
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub account lookup returned HTTP ${response.status}.`);
    }
    const account = accountSchema.safeParse(await response.json());
    if (!account.success) throw new Error("GitHub did not return valid account information.");
    return account.data;
  }

  private async device() {
    const value = await this.options.store.get("device");
    return value === null ? null : storedDeviceSchema.parse(value);
  }

  private pendingStatus(device: z.infer<typeof pendingSchema>): GitHubLoginStatus {
    return {
      state: "pending",
      message: "This agent is blocked until GitHub sign-in completes.",
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      expiresAt: new Date(device.expiresAt).toISOString(),
      pollAfterSeconds: Math.max(1, Math.ceil((device.nextPollAt - this.now()) / 1000)),
    };
  }

  async status(): Promise<GitHubLoginStatus> {
    let credential = await this.credentials();
    if (credential) {
      if (!credential.account && credential.expiresAt > this.now() && credential.refreshExpiresAt > this.now()) {
        credential = { ...credential, account: await this.account(credential.accessToken) };
        await this.options.store.set("credentials", credential);
      }
      const details = {
        account: credential.account,
        signedInAt: credential.signedInAt === undefined ? undefined : new Date(credential.signedInAt).toISOString(),
        expiresAt: new Date(credential.expiresAt).toISOString(),
        refreshExpiresAt: new Date(credential.refreshExpiresAt).toISOString(),
      };
      if (credential.refreshExpiresAt <= this.now()) {
        return { state: "expired", message: "GitHub sign-in expired. Sign in again to run this agent.", ...details };
      }
      return {
        state: "connected",
        message: "GitHub sign-in is complete.",
        ...details,
      };
    }
    const device = await this.device();
    if (device?.state === "pending" && device.clientId === this.options.clientId) {
      return device.expiresAt > this.now() ? this.pendingStatus(device) : {
        state: "expired", message: "GitHub sign-in expired. Start sign-in again.",
      };
    }
    if (device && device.state !== "pending" && device.state !== "complete") {
      return { state: device.state, message: device.message };
    }
    return { state: "required", message: "This agent is blocked until GitHub sign-in is completed." };
  }

  async start(): Promise<GitHubLoginStatus> {
    const existing = await this.device();
    if (existing?.state === "pending" && existing.clientId === this.options.clientId
      && existing.expiresAt > this.now()) return this.pendingStatus(existing);
    const response = await this.request({ scope: "offline_access" }, true);
    const device = z.object({
      device_code: z.string().min(1).max(1024),
      user_code: pendingSchema.shape.userCode,
      verification_uri: pendingSchema.shape.verificationUri,
      expires_in: z.number().int().positive().max(3600),
      interval: pendingSchema.shape.interval,
    }).safeParse(response);
    if (!device.success) throw new Error("GitHub did not return a valid device sign-in challenge.");
    const now = this.now();
    const pending = {
      state: "pending" as const,
      clientId: this.options.clientId,
      deviceCode: device.data.device_code,
      userCode: device.data.user_code,
      verificationUri: device.data.verification_uri,
      expiresAt: now + device.data.expires_in * 1000,
      interval: device.data.interval,
      nextPollAt: now + device.data.interval * 1000,
    };
    await this.options.store.set("credentials", { state: "required" });
    await this.options.store.set("device", pending);
    return this.pendingStatus(pending);
  }

  private async saveTokens(response: unknown, previous?: z.infer<typeof credentialSchema>) {
    const parsed = tokenSchema.safeParse(response);
    if (!parsed.success || parsed.data.expires_in * 1000 <= MIN_ASSIGNMENT_VALIDITY_MS) {
      throw new Error("GitHub must issue an expiring access token and a refresh token before this agent can run.");
    }
    const now = this.now();
    const credential = {
      state: "connected" as const,
      clientId: this.options.clientId,
      accessToken: parsed.data.access_token,
      expiresAt: now + parsed.data.expires_in * 1000,
      refreshToken: parsed.data.refresh_token,
      refreshExpiresAt: now + parsed.data.refresh_token_expires_in * 1000,
      account: previous?.account,
      signedInAt: previous ? previous.signedInAt : now,
    };
    await this.options.store.set("credentials", credential);
    return credential;
  }

  async poll(): Promise<GitHubLoginStatus> {
    const status = await this.status();
    if (status.state !== "pending") return status;
    const device = await this.device();
    if (!device || device.state !== "pending") return this.status();
    const now = this.now();
    if (device.expiresAt <= now || device.clientId !== this.options.clientId) return this.status();
    if (device.nextPollAt > now) return this.pendingStatus(device);
    await this.options.store.set("device", { ...device, nextPollAt: now + device.interval * 1000 });
    const response = await this.request({
      device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const error = z.object({ error: z.string(), interval: z.number().int().positive().max(3600).optional() }).safeParse(response);
    if (error.success) {
      if (error.data.error === "authorization_pending") return this.status();
      if (error.data.error === "slow_down") {
        const interval = Math.min(3600, Math.max(device.interval + 5, error.data.interval ?? 0));
        await this.options.store.set("device", { ...device, interval, nextPollAt: this.now() + interval * 1000 });
        return this.status();
      }
      if (["expired_token", "token_expired", "access_denied"].includes(error.data.error)) {
        await this.options.store.set("device", {
          state: error.data.error === "access_denied" ? "denied" : "expired",
          message: error.data.error === "access_denied"
            ? "GitHub sign-in was declined. This agent remains blocked."
            : "GitHub sign-in expired. Start sign-in again.",
        });
        return this.status();
      }
      await this.options.store.set("device", {
        state: "failed", message: "GitHub could not complete device sign-in. Start sign-in again.",
      });
      return this.status();
    }
    const valid = tokenSchema.safeParse(response);
    if (!valid.success || valid.data.expires_in * 1000 <= MIN_ASSIGNMENT_VALIDITY_MS) {
      await this.options.store.set("device", {
        state: "failed", message: "GitHub did not issue expiring access and refresh tokens. This agent remains blocked.",
      });
      return this.status();
    }
    await this.saveTokens(response);
    await this.options.store.set("device", { state: "complete", message: "GitHub sign-in is complete." });
    return this.status();
  }

  async assignmentToken(beforeRefresh: () => Promise<void>): Promise<{ accessToken: string; expiresAt: string }> {
    let credential = await this.credentials();
    if (!credential || credential.refreshExpiresAt <= this.now()) throw new GitHubLoginRequiredError();
    if (credential.expiresAt - this.now() <= MIN_ASSIGNMENT_VALIDITY_MS) {
      await beforeRefresh();
      const response = await this.request({ grant_type: "refresh_token", refresh_token: credential.refreshToken });
      const error = z.object({ error: z.string() }).safeParse(response);
      if (error.success) {
        if (["bad_refresh_token", "invalid_grant", "expired_token"].includes(error.data.error)) {
          await this.options.store.set("credentials", { state: "required" });
          throw new GitHubLoginRequiredError();
        }
        throw new Error("GitHub could not refresh this agent's access token.");
      }
      credential = await this.saveTokens(response, credential);
    }
    return { accessToken: credential.accessToken, expiresAt: new Date(credential.expiresAt).toISOString() };
  }
}
