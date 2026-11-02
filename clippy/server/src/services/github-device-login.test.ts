import { describe, expect, it, vi } from "vitest";
import { GitHubDeviceLogin, GitHubLoginRequiredError, type GitHubLoginStore } from "./github-device-login.js";

function fixture() {
  let now = Date.parse("2026-11-02T18:00:00Z");
  const values = new Map<string, unknown>();
  const responses: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>(async () => Response.json(responses.shift()));
  const store: GitHubLoginStore = {
    get: async key => structuredClone(values.get(key) ?? null),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
  };
  const options = { clientId: "test-client", store, fetcher, now: () => now };
  const login = new GitHubDeviceLogin(options);
  const challenge = {
    device_code: "private-device-code", user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5,
  };
  const tokens = {
    access_token: "private-access-token", expires_in: 28_800, token_type: "bearer",
    refresh_token: "private-refresh-token", refresh_token_expires_in: 15_897_600,
  };
  const account = { id: 12345, login: "agent-user" };
  return {
    login, options, store, values, responses, fetcher, challenge, tokens, account,
    advance: (milliseconds: number) => { now += milliseconds; },
    async connect() {
      responses.push(challenge, tokens, account);
      await login.start();
      now += 5000;
      return login.poll();
    },
  };
}

describe("per-agent GitHub device login", () => {
  it("blocks assignments until sign-in finishes and never publishes device or credential secrets", async () => {
    const f = fixture();
    await expect(f.login.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
    f.responses.push(f.challenge, { error: "authorization_pending" }, f.tokens, f.account);
    const pending = await f.login.start();
    expect(pending).toMatchObject({ state: "pending", userCode: "ABCD-1234", pollAfterSeconds: 5 });
    expect(String(f.fetcher.mock.calls[0]![1]?.body)).toContain("scope=offline_access");
    f.advance(5000);
    expect(await f.login.poll()).toMatchObject({ state: "pending" });
    await expect(f.login.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
    f.advance(5000);
    const connected = await f.login.poll();
    expect(connected).toMatchObject({
      state: "connected", account: f.account, signedInAt: "2026-11-02T18:00:10.000Z",
      refreshExpiresAt: new Date(Date.parse("2026-11-02T18:00:10Z") + f.tokens.refresh_token_expires_in * 1000).toISOString(),
    });
    expect(f.fetcher.mock.calls.at(-1)).toEqual(["https://api.github.com/user", expect.objectContaining({
      redirect: "error", headers: expect.objectContaining({ Authorization: `Bearer ${f.tokens.access_token}` }),
    })]);
    expect(JSON.stringify([pending, connected])).not.toMatch(/private-|accessToken|refreshToken|deviceCode/);
    expect(await f.login.assignmentToken(async () => {})).toEqual({
      accessToken: f.tokens.access_token, expiresAt: "2026-11-03T02:00:10.000Z",
    });
    expect(f.values.get("credentials")).toMatchObject({ refreshToken: f.tokens.refresh_token });
  });

  it("persists polling intervals across service instances and honors GitHub slow_down", async () => {
    const f = fixture();
    f.responses.push(f.challenge, { error: "slow_down", interval: 12 }, { error: "authorization_pending" });
    await f.login.start();
    await f.login.start();
    await f.login.poll();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.advance(5000);
    expect(await f.login.poll()).toMatchObject({ state: "pending", pollAfterSeconds: 12 });
    f.advance(11_000);
    await new GitHubDeviceLogin(f.options).poll();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.advance(1000);
    await f.login.poll();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["access_denied", "expired_token"])("keeps the agent blocked after %s", async error => {
    const f = fixture();
    f.responses.push(f.challenge, { error });
    await f.login.start();
    f.advance(5000);
    expect(await f.login.poll()).toMatchObject({ state: error === "access_denied" ? "denied" : "expired" });
    await expect(f.login.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
  });

  it("stops polling an expired challenge without contacting GitHub", async () => {
    const f = fixture();
    f.responses.push(f.challenge);
    await f.login.start();
    f.advance(901_000);
    expect(await f.login.poll()).toMatchObject({ state: "expired" });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("persists terminal device errors so the user can restart instead of polling indefinitely", async () => {
    const f = fixture();
    f.responses.push(f.challenge, { error: "incorrect_device_code" });
    await f.login.start();
    f.advance(5000);
    expect(await f.login.poll()).toMatchObject({ state: "failed" });
    expect(await new GitHubDeviceLogin(f.options).status()).toMatchObject({ state: "failed" });
    f.responses.push(f.challenge);
    expect(await f.login.start()).toMatchObject({ state: "pending" });
  });

  it("rejects non-expiring OAuth responses rather than falling back to a persistent access token", async () => {
    const f = fixture();
    f.responses.push(f.challenge, { access_token: "non-expiring-token", token_type: "bearer" });
    await f.login.start();
    f.advance(5000);
    expect(await f.login.poll()).toMatchObject({ state: "failed" });
    expect(f.values.get("credentials")).toEqual({ state: "required" });
  });

  it("rotates near-expiry credentials before handoff and stores the replacement refresh token", async () => {
    const f = fixture();
    const original = await f.connect();
    f.advance(7.5 * 60 * 60_000);
    f.responses.push({ ...f.tokens, access_token: "next-access", refresh_token: "next-refresh" });
    const beforeRefresh = vi.fn(async () => {});
    expect(await f.login.assignmentToken(beforeRefresh)).toMatchObject({ accessToken: "next-access" });
    expect(beforeRefresh).toHaveBeenCalledOnce();
    expect(f.values.get("credentials")).toMatchObject({ refreshToken: "next-refresh" });
    expect(String(f.fetcher.mock.calls.at(-1)![1]?.body)).toContain("grant_type=refresh_token");
    const refreshed = await f.login.status();
    expect(refreshed).toMatchObject({ account: f.account, signedInAt: original.signedInAt });
    expect(Date.parse(refreshed.refreshExpiresAt!) - Date.parse(original.refreshExpiresAt!)).toBe(7.5 * 60 * 60_000);
    expect(JSON.stringify(refreshed)).not.toContain("next-");
  });

  it("reports expired refresh credentials with the original account and sign-in time", async () => {
    const f = fixture();
    const original = await f.connect();
    const calls = f.fetcher.mock.calls.length;
    f.advance(f.tokens.refresh_token_expires_in * 1000);
    expect(await f.login.status()).toMatchObject({
      state: "expired", account: f.account, signedInAt: original.signedInAt,
      refreshExpiresAt: original.refreshExpiresAt,
    });
    await expect(f.login.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("backfills a legacy account without inventing a sign-in time, including after token rotation", async () => {
    const f = fixture();
    await f.store.set("credentials", {
      state: "connected", clientId: f.options.clientId,
      accessToken: f.tokens.access_token, refreshToken: f.tokens.refresh_token,
      expiresAt: Date.parse("2026-11-03T02:00:00Z"),
      refreshExpiresAt: Date.parse("2027-05-01T18:00:00Z"),
    });
    f.responses.push(f.account);
    expect(await f.login.status()).toMatchObject({ state: "connected", account: f.account });
    expect((await f.login.status()).signedInAt).toBeUndefined();
    expect(f.fetcher).toHaveBeenCalledOnce();
    f.advance(8 * 60 * 60_000);
    f.responses.push({ ...f.tokens, refresh_token: "rotated-legacy-refresh" });
    await f.login.assignmentToken(async () => {});
    expect(await f.login.status()).toMatchObject({ account: f.account });
    expect((await f.login.status()).signedInAt).toBeUndefined();
  });

  it("keeps issued tokens safe and surfaces an account lookup failure for retry", async () => {
    const f = fixture();
    f.responses.push(f.challenge, f.tokens, { message: "Invalid account response" });
    await f.login.start();
    f.advance(5000);
    await expect(f.login.poll()).rejects.toThrow("GitHub did not return valid account information");
    expect(f.values.get("credentials")).toMatchObject({
      refreshToken: f.tokens.refresh_token, signedInAt: Date.parse("2026-11-02T18:00:05Z"),
    });
    f.responses.push(f.account);
    expect(await f.login.poll()).toMatchObject({
      state: "connected", account: f.account, signedInAt: "2026-11-02T18:00:05.000Z",
    });
    expect(f.fetcher.mock.calls.filter(([url]) => url === "https://github.com/login/oauth/access_token")).toHaveLength(1);
  });

  it("waits for token refresh before resolving a legacy account with an expired access token", async () => {
    const f = fixture();
    await f.store.set("credentials", {
      state: "connected", clientId: f.options.clientId,
      accessToken: f.tokens.access_token, refreshToken: f.tokens.refresh_token,
      expiresAt: Date.parse("2026-11-02T17:00:00Z"),
      refreshExpiresAt: Date.parse("2027-05-01T18:00:00Z"),
    });
    expect(await f.login.status()).toMatchObject({ state: "connected" });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.responses.push({ ...f.tokens, access_token: "next-access" }, f.account);
    await f.login.assignmentToken(async () => {});
    expect(await f.login.status()).toMatchObject({ account: f.account });
    expect((await f.login.status()).signedInAt).toBeUndefined();
    expect(f.fetcher.mock.calls.at(-1)).toEqual(["https://api.github.com/user", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer next-access" }),
    })]);
  });

  it("does not invalidate an active assignment's token by rotating while another assignment is running", async () => {
    const f = fixture();
    await f.connect();
    f.advance(7.5 * 60 * 60_000);
    const calls = f.fetcher.mock.calls.length;
    await expect(f.login.assignmentToken(async () => { throw new Error("Existing assignment is running"); }))
      .rejects.toThrow("Existing assignment is running");
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(await f.login.status()).toMatchObject({ state: "connected" });
  });

  it("requires another login when GitHub rejects the refresh token", async () => {
    const f = fixture();
    await f.connect();
    f.advance(7.5 * 60 * 60_000);
    f.responses.push({ error: "bad_refresh_token" });
    await expect(f.login.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
    expect(await f.login.status()).toMatchObject({ state: "required" });
  });

  it("does not hand out refreshed credentials when Key Vault persistence fails", async () => {
    const f = fixture();
    await f.connect();
    f.advance(7.5 * 60 * 60_000);
    f.responses.push({ ...f.tokens, access_token: "next-access", refresh_token: "next-refresh" });
    f.store.set = async () => { throw new Error("Vault unavailable"); };
    await expect(f.login.assignmentToken(async () => {})).rejects.toThrow("Vault unavailable");
  });

  it("does not reuse another GitHub App's stored login", async () => {
    const f = fixture();
    await f.connect();
    const other = new GitHubDeviceLogin({ ...f.options, clientId: "other-client" });
    expect(await other.status()).toMatchObject({ state: "required" });
    await expect(other.assignmentToken(async () => {})).rejects.toBeInstanceOf(GitHubLoginRequiredError);
  });
});
