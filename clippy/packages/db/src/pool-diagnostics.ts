import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

const WAIT_MS = 5_000;
const REPORT_INTERVAL_MS = 30_000;
const MAX_TRACKED = 128;
const MAX_REPORTED = 20;
type Operation = {
  id: string;
  kind: "query" | "transaction";
  requestId: string | null;
  startedAt: number;
  stack: string[];
  transaction?: Operation;
  poolId: string;
  acquiredAt?: number;
  finishedAt?: number;
  pid?: number;
  query?: Promise<unknown>;
  scope?: "root" | "transaction";
};
const requestContext = new AsyncLocalStorage<string>();
const transactionContext = new AsyncLocalStorage<Operation>();

export function databasePoolDiagnosticsEnabled(): boolean {
  const value = process.env.DATABASE_POOL_DIAGNOSTICS?.trim().toLowerCase();
  if (!value) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("DATABASE_POOL_DIAGNOSTICS must be true or false");
}

/** Use only server-generated IDs, never headers, URLs, actor details or bodies. */
export function withDatabaseDiagnosticRequest<T>(requestId: string, callback: () => T): T {
  if (!databasePoolDiagnosticsEnabled()) return callback();
  return requestContext.run(/^[\w.:-]{1,80}$/.test(requestId) ? requestId : "unavailable", callback);
}

function callSite(): string[] {
  return (new Error().stack?.split("\n").slice(2, 14) ?? [])
    .filter((line) => /^\s+at /.test(line))
    .map((line) => line.trim().slice(0, 256));
}

function backendPid(query: Promise<unknown> | undefined): number | undefined {
  const state: unknown = query && Reflect.get(query, "state");
  if (!state || typeof state !== "object") return undefined;
  const pid: unknown = Reflect.get(state, "pid");
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Observe Drizzle's postgres.js unsafe queries and transaction callbacks.
 * Wrapping only consumption preserves lazy queries and all driver modifiers.
 * No SQL text, parameters, errors, backend secrets or connection URLs are read.
 */
export function installDatabasePoolDiagnostics(client: postgres.Sql, maxConnections: number): void {
  const poolId = randomUUID();
  const operations = new Map<string, Operation>();
  const installed = new WeakSet<object>();
  let dropped = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastReport = -Infinity;
  let reported = false;

  function emit(event: string, fields: Record<string, unknown> = {}) {
    console.warn(JSON.stringify({ level: 40, time: Date.now(), event, poolId, ...fields }));
  }

  function project(operation: Operation, now: number) {
    const pid = backendPid(operation.query) ?? operation.pid;
    return {
      id: operation.id,
      kind: operation.kind,
      requestId: operation.requestId,
      startedAt: operation.startedAt,
      acquiredAt: operation.acquiredAt ?? null,
      elapsedMs: now - operation.startedAt,
      stage: operation.kind === "transaction"
        ? operation.acquiredAt === undefined ? "acquiring" : "held"
        : pid === undefined ? "awaiting_connection" : "in_flight",
      pid: pid ?? null,
      scope: operation.scope ?? null,
      enclosingTransactionId: operation.transaction?.id ?? null,
      enclosingPoolId: operation.transaction?.poolId ?? null,
      enclosingTransactionState: !operation.transaction ? null
        : operation.transaction.finishedAt !== undefined ? "settled"
          : operation.transaction.acquiredAt === undefined ? "acquiring" : "held",
      samePoolTransaction: operation.transaction?.poolId === poolId,
      stack: operation.stack,
    };
  }

  function report() {
    const now = Date.now();
    const slow = [...operations.values()].filter((operation) => now - operation.startedAt >= WAIT_MS);
    if (!slow.length || now - lastReport < REPORT_INTERVAL_MS) return;
    lastReport = now;
    reported = true;
    const selected = new Set<Operation>();
    for (const operation of slow) {
      if (operation.scope !== "root" || operation.transaction?.poolId !== poolId
        || operation.transaction.acquiredAt === undefined || operation.transaction.finishedAt !== undefined) continue;
      selected.add(operation.transaction);
      selected.add(operation);
    }
    for (const operation of operations.values()) selected.add(operation);
    const entries = [...selected].slice(0, MAX_REPORTED).map((operation) => project(operation, now));
    // Keep each JSON event below console-log collector size limits.
    while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > 24_000) entries.pop();
    emit("database_pool_wait_snapshot", {
      maxConnections,
      tracked: operations.size,
      dropped,
      slow: slow.length,
      omitted: operations.size - entries.length,
      operations: entries,
    });
  }

  function start(kind: Operation["kind"], stack: string[]): Operation {
    const operation: Operation = {
      id: randomUUID(), kind, startedAt: Date.now(), stack,
      requestId: requestContext.getStore() ?? null, poolId,
      transaction: transactionContext.getStore(),
    };
    if (operations.size < MAX_TRACKED) operations.set(operation.id, operation);
    else dropped++;
    if (!timer) {
      timer = setInterval(report, 1_000);
      timer.unref();
    }
    return operation;
  }

  function finish(operation: Operation) {
    operation.finishedAt = Date.now();
    operations.delete(operation.id);
    if (operations.size) return;
    clearInterval(timer);
    timer = undefined;
    if (reported) emit("database_pool_wait_recovered");
    reported = false;
    dropped = 0;
  }

  function install(sql: postgres.Sql | postgres.TransactionSql, owner?: Operation) {
    if (installed.has(sql)) return;
    installed.add(sql);
    sql.unsafe = new Proxy(sql.unsafe, {
      apply(target, receiver, args) {
        const query: unknown = Reflect.apply(target, receiver, args);
        if (!(query instanceof Promise)) {
          emit("database_pool_diagnostics_unsupported_query");
          return query;
        }
        const stack = callSite();
        let started = false;
        query.then = new Proxy(query.then, {
          apply(then, thisArg, thenArgs) {
            if (!started) {
              started = true;
              const operation = start("query", stack);
              operation.query = query;
              operation.scope = owner ? "transaction" : "root";
              // Ownership comes from the actual driver handle, not merely ALS.
              if (owner) operation.transaction = owner;
              const settled = () => {
                const transaction = owner ?? operation.transaction;
                if (transaction && (owner || transaction.acquiredAt === undefined)) {
                  transaction.pid = backendPid(query) ?? transaction.pid;
                }
                finish(operation);
              };
              // Native subscription does not invoke postgres.js handle() early.
              Promise.prototype.then.call(query, settled, settled);
            }
            return Reflect.apply(then, thisArg, thenArgs);
          },
        });
        return query;
      },
    });
    const method = owner ? "savepoint" : "begin";
    const original: unknown = Reflect.get(sql, method);
    if (typeof original !== "function") return;
    Reflect.set(sql, method, new Proxy(original, {
      apply(target, receiver, args: unknown[]) {
        const callbackIndex = args.findIndex((argument) => typeof argument === "function");
        const callback = args[callbackIndex];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        const operation = owner ?? start("transaction", callSite());
        const wrapped = [...args];
        wrapped[callbackIndex] = (scoped: postgres.TransactionSql) => {
          operation.acquiredAt ??= Date.now();
          install(scoped, operation);
          return transactionContext.run(operation, () => callback(scoped));
        };
        if (owner) return Reflect.apply(target, receiver, wrapped);
        return (async () => {
          try {
            return await transactionContext.run(operation, () => Reflect.apply(target, receiver, wrapped));
          }
          finally { finish(operation); }
        })();
      },
    }));
  }

  install(client);
}
