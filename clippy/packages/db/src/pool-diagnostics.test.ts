import { setImmediate } from "node:timers/promises";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "./client.js";
import { withDatabaseDiagnosticRequest } from "./pool-diagnostics.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("database pool diagnostics", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const cleanups: Array<() => Promise<void>> = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-pool-diagnostics-"); }, 20_000);
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => { await database?.cleanup(); });

  function pool() {
    vi.stubEnv("DATABASE_POOL_DIAGNOSTICS", "true");
    const db = createDb(database.connectionString, { maxConnections: 1 });
    cleanups.push(() => db.$client.end({ timeout: 0 }));
    return db;
  }

  it("reports a queued root query with its held transaction, PID and request, without SQL or bindings", async () => {
    const db = pool();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.execute(sql`select 1`);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let escaped: Promise<unknown> | undefined;
    const transaction = withDatabaseDiagnosticRequest("server-generated-request-42", () =>
      db.transaction(async () => {
        escaped = db.execute(sql`select ${"DO_NOT_LOG_QUERY_BINDINGS_TEST"}::text as secret_alias`).then((rows) => rows);
        entered();
        await gate;
      }),
    );
    cleanups.push(async () => { release(); await Promise.all([transaction, escaped]); });
    await ready;
    await setImmediate();
    expect(log).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    const snapshots = () => log.mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event === "database_pool_wait_snapshot");
    const snapshot = snapshots()[0];
    expect(snapshot).toMatchObject({ maxConnections: 1, tracked: 2, dropped: 0 });
    expect(snapshot.operations).toEqual([
      expect.objectContaining({ kind: "transaction", stage: "held", pid: expect.any(Number) }),
      expect.objectContaining({
        kind: "query", scope: "root", stage: "awaiting_connection", pid: null,
        requestId: "server-generated-request-42", samePoolTransaction: true,
        enclosingTransactionId: snapshot.operations[0].id,
        enclosingTransactionState: "held",
      }),
    ]);
    expect(snapshot.operations.every((entry: { stack: string[] }) => entry.stack.length > 0)).toBe(true);
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain("DO_NOT_LOG_QUERY_BINDINGS_TEST");
    expect(output).not.toContain("secret_alias");
    expect(output).not.toContain(database.connectionString);
    expect(output).not.toContain('"secret":');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(snapshots()).toHaveLength(1);
    release();
    await Promise.all([transaction, escaped]);
    expect(log.mock.calls.some(([line]) => JSON.parse(String(line)).event === "database_pool_wait_recovered")).toBe(true);
    const calls = log.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).toHaveBeenCalledTimes(calls);
  }, 15_000);

  it("preserves laziness, query modifiers, nested savepoints and rollback cleanup", async () => {
    const db = pool();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.execute(sql`select 1`);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const lazy = db.$client.unsafe("select 7 as value");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(log).not.toHaveBeenCalled();
    expect(await lazy.values()).toEqual([[7]]);
    expect(await lazy).toEqual([[7]]);
    await expect(withDatabaseDiagnosticRequest("rollback-request", () => db.transaction(async (tx) => {
      await tx.execute(sql`create temporary table diagnostic_rollback (value int)`);
      await tx.transaction(async (nested) => {
        await nested.execute(sql`insert into diagnostic_rollback values (1)`);
      });
      throw new Error("expected rollback");
    }))).rejects.toThrow("expected rollback");
    await expect(db.execute(sql`select to_regclass('pg_temp.diagnostic_rollback') as name`))
      .resolves.toMatchObject([{ name: null }]);
    await expect(db.execute(sql`select * from diagnostic_private_missing_table`)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log).not.toHaveBeenCalled();
  }, 15_000);

  it("bounds tracked operations and report size under queue pressure", async () => {
    const db = pool();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    await db.execute(sql`select 1`);
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const queued: Promise<unknown>[] = [];
    const transaction = db.transaction(async () => {
      for (let index = 0; index < 160; index++) queued.push(db.execute(sql`select 1`).then((rows) => rows));
      entered();
      await gate;
    });
    cleanups.push(async () => { release(); await Promise.all([transaction, ...queued]); });
    await ready;
    await setImmediate();
    await vi.advanceTimersByTimeAsync(6_000);
    const snapshot = log.mock.calls.map(([line]) => JSON.parse(String(line)))
      .find((entry) => entry.event === "database_pool_wait_snapshot");
    expect(snapshot).toMatchObject({ tracked: 128, dropped: expect.any(Number) });
    expect(snapshot.dropped).toBeGreaterThan(0);
    expect(snapshot.operations.length).toBeGreaterThan(0);
    expect(snapshot.operations.length).toBeLessThanOrEqual(20);
    expect(snapshot.omitted).toBe(128 - snapshot.operations.length);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(25_000);
    release();
    await Promise.all([transaction, ...queued]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))
      .filter((entry) => entry.event === "database_pool_wait_snapshot")).toHaveLength(1);
  }, 15_000);
});
