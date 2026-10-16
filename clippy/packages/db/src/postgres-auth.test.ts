import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  credentialOptions: vi.fn(),
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    constructor(options: unknown) {
      mocks.credentialOptions(options);
    }
    getToken = mocks.getToken;
  },
}));

const azureUrl = "postgres://app@fixture.postgres.database.azure.com/paperclip?sslmode=require";

beforeEach(() => {
  vi.resetModules();
  mocks.getToken.mockReset();
  mocks.credentialOptions.mockReset();
  vi.stubEnv("AZURE_CLIENT_ID", "fixture-client-id");
  vi.stubEnv("PGPASSWORD", "");
  vi.stubEnv("PGSSLROOTCERT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Azure PostgreSQL authentication", () => {
  it.each([
    "",
    "postgres://app@localhost/paperclip",
    "postgres://app@127.0.0.1/paperclip",
    "postgres://app@fixture.postgres.database.azure.com.attacker.test/paperclip",
    "postgres://app@notpostgres.database.azure.com/paperclip",
    "postgres://app:explicit-password@fixture.postgres.database.azure.com/paperclip",
  ])("preserves non-Entra connection settings for %s", async (url) => {
    const { resolvePostgresAuthOptions, resolvePostgresCliConnection } = await import("./postgres-auth.js");
    expect(resolvePostgresAuthOptions(url)).toEqual({});
    vi.stubEnv("PGPASSWORD", "existing-password");
    const cli = await resolvePostgresCliConnection(url);
    expect(cli.connectionString).toBe(url);
    expect(cli.env.PGPASSWORD).toBe("existing-password");
    expect(mocks.credentialOptions).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("authenticates new pooled connections with the shared credential and verifies TLS", async () => {
    const { resolvePostgresAuthOptions } = await import("./postgres-auth.js");
    mocks.getToken.mockResolvedValueOnce({ token: "first-token" }).mockResolvedValueOnce({ token: "renewed-token" });
    const options = resolvePostgresAuthOptions(azureUrl);
    const secondUrl = azureUrl.replace("postgres:", "postgresql:");
    const secondOptions = resolvePostgresAuthOptions(secondUrl);
    const sql = postgres(azureUrl, options);
    const second = postgres(secondUrl, secondOptions);
    try {
      expect(sql.options.ssl).toBe("verify-full");
      expect(mocks.getToken).not.toHaveBeenCalled();
      expect(sql.options.pass).toBe(options.password);
      expect(second.options.pass).toBe(secondOptions.password);
      const password = options.password;
      const secondPassword = secondOptions.password;
      if (typeof password !== "function" || typeof secondPassword !== "function") {
        throw new Error("Expected per-connection token callbacks.");
      }
      expect(await password()).toBe("first-token");
      expect(await secondPassword()).toBe("renewed-token");
      expect(mocks.credentialOptions).toHaveBeenCalledExactlyOnceWith({
        managedIdentityClientId: "fixture-client-id",
      });
      expect(mocks.getToken.mock.calls).toEqual([
        ["https://ossrdbms-aad.database.windows.net/.default"],
        ["https://ossrdbms-aad.database.windows.net/.default"],
      ]);
    } finally {
      await sql.end();
      await second.end();
    }
  });

  it("allows the default credential chain when no managed identity client ID is set", async () => {
    vi.stubEnv("AZURE_CLIENT_ID", undefined);
    mocks.getToken.mockResolvedValue({ token: "developer-token" });
    const { resolvePostgresAuthOptions } = await import("./postgres-auth.js");
    await resolvePostgresAuthOptions(azureUrl).password?.();
    expect(mocks.credentialOptions).toHaveBeenCalledExactlyOnceWith({ managedIdentityClientId: undefined });
  });

  it("propagates token acquisition failures and rejects empty tokens", async () => {
    const { resolvePostgresAuthOptions } = await import("./postgres-auth.js");
    const failure = new Error("Managed identity unavailable");
    mocks.getToken.mockRejectedValueOnce(failure).mockResolvedValueOnce(null).mockResolvedValueOnce({ token: "" });
    const options = resolvePostgresAuthOptions(azureUrl);
    await expect(options.password?.()).rejects.toBe(failure);
    await expect(options.password?.()).rejects.toThrow("returned no access token");
    await expect(options.password?.()).rejects.toThrow("returned no access token");
  });

  it("refreshes CLI tokens in child-only environment settings without putting them in URLs", async () => {
    const { resolvePostgresCliConnection } = await import("./postgres-auth.js");
    vi.stubEnv("PGPASSWORD", "previous-password");
    mocks.getToken.mockResolvedValueOnce({ token: "dump-token" }).mockResolvedValueOnce({ token: "restore-token" });
    const dump = await resolvePostgresCliConnection(azureUrl);
    const restore = await resolvePostgresCliConnection(azureUrl);
    expect(dump.env.PGPASSWORD).toBe("dump-token");
    expect(restore.env.PGPASSWORD).toBe("restore-token");
    expect(process.env.PGPASSWORD).toBe("previous-password");
    expect(dump.connectionString).not.toContain("dump-token");
    const url = new URL(dump.connectionString);
    expect(url.password).toBe("");
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.get("sslrootcert")).toBe("system");
    expect(mocks.credentialOptions).toHaveBeenCalledTimes(1);
  });

  it("preserves explicitly configured libpq certificate roots", async () => {
    const { resolvePostgresCliConnection } = await import("./postgres-auth.js");
    mocks.getToken.mockResolvedValue({ token: "fixture-token" });
    vi.stubEnv("PGSSLROOTCERT", "trusted-ca.pem");
    const envRoot = await resolvePostgresCliConnection(azureUrl);
    expect(new URL(envRoot.connectionString).searchParams.has("sslrootcert")).toBe(false);
    expect(envRoot.env.PGSSLROOTCERT).toBe("trusted-ca.pem");
    const urlRoot = await resolvePostgresCliConnection(`${azureUrl}&sslrootcert=url-ca.pem`);
    expect(new URL(urlRoot.connectionString).searchParams.get("sslrootcert")).toBe("url-ca.pem");
  });
});
