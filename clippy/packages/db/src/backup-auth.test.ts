import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDatabaseBackup, runDatabaseRestore } from "./backup-lib.js";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  postgres: vi.fn(),
  sql: Object.assign(vi.fn(async () => []), { end: vi.fn(async () => {}) }),
  children: [] as Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }>,
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {
    getToken = mocks.getToken;
  },
}));
vi.mock("postgres", () => ({ default: mocks.postgres }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      mocks.children.push({ command, args, env: options.env });
      const script = command === "pg_dump"
        ? "process.stdout.write('SELECT 1;\\n')"
        : "process.stdin.resume()";
      return actual.spawn(process.execPath, ["-e", script], options);
    },
  };
});

const azureUrl = "postgres://app@fixture.postgres.database.azure.com/paperclip?sslmode=require";
let directory: string;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.children.length = 0;
  mocks.postgres.mockReturnValue(mocks.sql);
  mocks.getToken.mockResolvedValue({ token: "fixture-token" });
  vi.stubEnv("PGPASSWORD", "parent-password");
  vi.stubEnv("PGSSLROOTCERT", "");
  vi.stubEnv("PAPERCLIP_PG_DUMP_PATH", "");
  vi.stubEnv("PAPERCLIP_PSQL_PATH", "");
  directory = await mkdtemp(join(tmpdir(), "paperclip-backup-auth-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("Azure backup and restore authentication", () => {
  it("passes tokens only in the pg_dump/psql child environments and configures the backup DB client", async () => {
    const backup = await runDatabaseBackup({
      connectionString: azureUrl,
      backupDir: directory,
      backupEngine: "pg_dump",
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    });
    expect(gunzipSync(await readFile(backup.backupFile)).toString()).toBe("SELECT 1;\n");
    await runDatabaseRestore({ connectionString: azureUrl, backupFile: backup.backupFile });
    expect(mocks.postgres).toHaveBeenCalledWith(azureUrl, expect.objectContaining({
      password: expect.any(Function), ssl: "verify-full",
    }));
    expect(mocks.children.map(child => child.command)).toEqual(["pg_dump", "psql"]);
    for (const child of mocks.children) {
      expect(child.env?.PGPASSWORD).toBe("fixture-token");
      expect(child.env?.PGCONNECT_TIMEOUT).toBe("5");
      expect(child.args.join(" ")).not.toContain("fixture-token");
      const url = new URL(child.args[0]!.slice("--dbname=".length));
      expect(url.password).toBe("");
      expect(url.searchParams.get("sslmode")).toBe("verify-full");
    }
    expect(mocks.getToken).toHaveBeenCalledTimes(2);
    expect(process.env.PGPASSWORD).toBe("parent-password");
  });

  it("surfaces token failures before spawning either CLI", async () => {
    const failure = new Error("Managed identity unavailable");
    mocks.getToken.mockRejectedValue(failure);
    await expect(runDatabaseBackup({
      connectionString: azureUrl, backupDir: directory, backupEngine: "pg_dump",
      retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    })).rejects.toBe(failure);
    const backupFile = join(directory, "restore.sql");
    await writeFile(backupFile, "SELECT 1;\n");
    await expect(runDatabaseRestore({ connectionString: azureUrl, backupFile }))
      .rejects.toThrow("Managed identity unavailable");
    expect(mocks.children).toHaveLength(0);
  });
});
