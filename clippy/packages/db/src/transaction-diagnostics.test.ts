import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionDiagnostics } from "./transaction-diagnostics.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function warningDetails() {
  return vi.mocked(process.emitWarning).mock.calls.map(call => {
    const options = call[1];
    if (typeof options !== "object" || !options?.detail) throw new Error("Missing warning details");
    return JSON.parse(options.detail);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("transaction diagnostics", () => {
  it("preserves results and errors and cleans up completed transactions", async () => {
    const diagnostics = createTransactionDiagnostics({ warnAfterMs: 100, poolMax: 1 });
    expect(await diagnostics.transaction(callback => callback(undefined), async () => 42)).toBe(42);
    const failure = new Error("Transaction failed");
    await expect(diagnostics.transaction(callback => callback(undefined), async () => {
      throw failure;
    })).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(process.emitWarning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["acquiring_connection", "callback", "settling_transaction"] as const)(
    "reports %s without logging SQL literals",
    async phase => {
      const diagnostics = createTransactionDiagnostics({ warnAfterMs: 100, poolMax: 1, applicationName: "test" });
      const gate = deferred();
      const callbackStarted = deferred();
      const result = diagnostics.transaction(async callback => {
        if (phase === "acquiring_connection") await gate.promise;
        const value = await callback(undefined);
        if (phase === "settling_transaction") await gate.promise;
        return value;
      }, async () => {
        diagnostics.logger?.logQuery("select 'private-query-literal'");
        callbackStarted.resolve();
        if (phase === "callback") await gate.promise;
        return 42;
      });
      try {
        if (phase !== "acquiring_connection") await callbackStarted.promise;
        await vi.advanceTimersByTimeAsync(100);
        expect(warningDetails()).toEqual([expect.objectContaining({
          phase,
          poolMax: 1,
          applicationName: "test",
          waitingTransactionCount: phase === "acquiring_connection" ? 1 : 0,
          activeTransactionCount: phase === "acquiring_connection" ? 0 : 1,
          origin: expect.stringContaining("transaction-diagnostics.test.ts"),
          lastQuery: phase === "acquiring_connection" ? null : expect.objectContaining({
            operation: "select",
            origin: expect.stringContaining("transaction-diagnostics.test.ts"),
          }),
        })]);
        expect(JSON.stringify(warningDetails())).not.toContain("private-query-literal");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(process.emitWarning).toHaveBeenCalledTimes(1);
      } finally {
        gate.resolve();
        expect(await result).toBe(42);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("keeps concurrent query origins separate and counts pending transaction attempts", async () => {
    const diagnostics = createTransactionDiagnostics({ warnAfterMs: 100, poolMax: 2 });
    const gate = deferred();
    const queries = ["select 'first-secret'", "update private_table set secret = 'second-secret'"];
    const results = queries.map(query => diagnostics.transaction(callback => callback(undefined), async () => {
      await Promise.resolve();
      diagnostics.logger?.logQuery(query);
      await gate.promise;
    }));
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(warningDetails()).toEqual([
        expect.objectContaining({ transactionId: 1, activeTransactionCount: 2, lastQuery: expect.objectContaining({ operation: "select" }) }),
        expect.objectContaining({ transactionId: 2, activeTransactionCount: 2, lastQuery: expect.objectContaining({ operation: "update" }) }),
      ]);
      expect(JSON.stringify(warningDetails())).not.toMatch(/first-secret|second-secret|private_table/);
    } finally {
      gate.resolve();
      await Promise.all(results);
    }
  });

  it("can disable diagnostics without adding timers or changing transaction behavior", async () => {
    const diagnostics = createTransactionDiagnostics({ warnAfterMs: 0, poolMax: 1 });
    expect(diagnostics.logger).toBeUndefined();
    expect(await diagnostics.transaction(callback => callback(undefined), async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      return 42;
    })).toBe(42);
    expect(process.emitWarning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
