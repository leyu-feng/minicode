import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

type Phase = "acquiring_connection" | "callback" | "settling_transaction";
type QueryOrigin = { operation: string; requestedAt: number; origin: Error; poolId: string };
type Transaction = {
  id: number;
  requestedAt: number;
  callbackStartedAt?: number;
  origin: Error;
  phase: Phase;
  lastQuery?: QueryOrigin;
};
type Options = { warnAfterMs: number; applicationName?: string; poolMax: number };

const currentTransaction = new AsyncLocalStorage<Transaction>();
const operations = new Set(["select", "insert", "update", "delete", "with", "create", "alter", "drop"]);
export const DEFAULT_TRANSACTION_WARN_AFTER_MS = 30_000;

export function createTransactionDiagnostics(options: Options) {
  const poolId = randomUUID();
  const transactions = new Set<Transaction>();
  let sequence = 0;

  return {
    logger: options.warnAfterMs === 0 ? undefined : {
      logQuery(query: string) {
        const transaction = currentTransaction.getStore();
        if (!transaction) return;
        const keyword = query.trimStart().match(/^[a-z]+/i)?.[0].toLowerCase() ?? "";
        transaction.lastQuery = {
          operation: operations.has(keyword) ? keyword : "other",
          requestedAt: performance.now(),
          origin: new Error("Last database query issued here"),
          poolId,
        };
      },
    },
    async transaction<T, Tx>(
      start: (callback: (tx: Tx) => Promise<T>) => Promise<T>,
      callback: (tx: Tx) => Promise<T>,
    ): Promise<T> {
      if (options.warnAfterMs === 0) return start(callback);
      const transaction: Transaction = {
        id: ++sequence,
        requestedAt: performance.now(),
        origin: new Error("Database transaction requested here"),
        phase: "acquiring_connection",
      };
      transactions.add(transaction);
      const timer = setTimeout(() => {
        const now = performance.now();
        const lastQuery = transaction.lastQuery;
        process.emitWarning("Database transaction exceeded warning threshold", {
          code: "PAPERCLIP_DATABASE_TRANSACTION_STALLED",
          detail: JSON.stringify({
            poolId,
            transactionId: transaction.id,
            applicationName: options.applicationName,
            poolMax: options.poolMax,
            phase: transaction.phase,
            elapsedMs: Math.round(now - transaction.requestedAt),
            callbackElapsedMs: transaction.callbackStartedAt === undefined
              ? null : Math.round(now - transaction.callbackStartedAt),
            waitingTransactionCount: [...transactions].filter(tx => tx.phase === "acquiring_connection").length,
            activeTransactionCount: [...transactions].filter(tx => tx.phase !== "acquiring_connection").length,
            origin: transaction.origin.stack,
            lastQuery: lastQuery ? {
              operation: lastQuery.operation,
              ageMs: Math.round(now - lastQuery.requestedAt),
              poolId: lastQuery.poolId,
              origin: lastQuery.origin.stack,
            } : null,
          }),
        });
      }, options.warnAfterMs);
      timer.unref();
      try {
        return await start(tx => {
          transaction.phase = "callback";
          transaction.callbackStartedAt = performance.now();
          return currentTransaction.run(transaction, async () => {
            try { return await callback(tx); }
            finally { transaction.phase = "settling_transaction"; }
          });
        });
      } finally {
        clearTimeout(timer);
        transactions.delete(transaction);
      }
    },
  };
}
