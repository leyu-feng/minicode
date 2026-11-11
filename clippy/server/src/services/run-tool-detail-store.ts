import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { DefaultAzureCredential } from "@azure/identity";
import {
  runToolDetailSchema, runToolDetailRefSchema,
  type RunToolDetail, type RunToolDetailRef, type RunToolDetailPage,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const MAX_CHUNK_BYTES = 192 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export interface ToolDetailArchive {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

export function createAzureToolDetailArchive(containerUrl: string, options: {
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
} = {}): ToolDetailArchive {
  const container = new URL(containerUrl);
  if (container.protocol !== "https:" || container.username || container.password
    || container.search || container.hash || container.port
    || !/^[a-z0-9.-]+\.blob\.core\.(windows\.net|usgovcloudapi\.net|chinacloudapi\.cn)$/.test(container.hostname)
    || !/^\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/?$/.test(container.pathname)) {
    throw new Error("RUN_TOOL_DETAILS_AZURE_CONTAINER_URL must be an Azure Blob container HTTPS URL without credentials");
  }
  const credential = options.getToken ? null : new DefaultAzureCredential();
  const getToken = options.getToken ?? (async () => {
    const token = await credential!.getToken("https://storage.azure.com/.default");
    if (!token) throw new Error("Azure Blob authentication returned no token");
    return token.token;
  });
  const fetchObject = async (key: string, init?: RequestInit) => {
    if (!/^[a-f0-9/-]+\.json\.gz$/i.test(key)) throw new Error("Invalid tool detail object key");
    const url = `${container.href.replace(/\/$/, "")}/run-tool-details/v1/${key}`;
    return (options.fetch ?? fetch)(url, {
      ...init, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        "x-ms-version": "2023-11-03",
        ...init?.headers,
      },
    });
  };
  return {
    async put(key, bytes) {
      const digest = createHash("sha256").update(bytes).digest("hex");
      const response = await fetchObject(key, {
        method: "PUT",
        headers: {
          "x-ms-blob-type": "BlockBlob", "Content-Type": "application/gzip",
          "x-ms-meta-sha256": digest, "If-None-Match": "*",
        },
        body: new Uint8Array(bytes),
      });
      await response.body?.cancel();
      if (response.status === 412) {
        const head = await fetchObject(key, { method: "HEAD" });
        if (head.ok && head.headers.get("x-ms-meta-sha256") === digest) return;
        throw new Error("Tool detail archive immutable object conflict");
      }
      if (!response.ok) throw new Error(`Azure Blob tool detail upload failed (HTTP ${response.status})`);
    },
    async get(key) {
      const response = await fetchObject(key);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Azure Blob tool detail read failed (HTTP ${response.status})`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Azure Blob tool detail response has no body");
      const parts: Buffer[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) return Buffer.concat(parts);
          size += item.value.byteLength;
          if (size > MAX_CHUNK_BYTES) throw new Error("Azure Blob tool detail exceeds the chunk limit");
          parts.push(Buffer.from(item.value));
        }
      } finally {
        await reader.cancel();
      }
    },
  };
}

interface StoredDetail {
  companyId: string;
  runId: string;
  expiresAt: number;
  detail: RunToolDetail;
}

export function createRunToolDetailStore(options: {
  basePath: string;
  archive?: ToolDetailArchive;
  maxBytes?: number;
  cacheGraceMs?: number;
  now?: () => number;
  intervalMs?: number;
}) {
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const cacheGraceMs = options.cacheGraceMs ?? 5 * 60 * 1000;
  let queue: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setInterval> | undefined;
  let initialized: Promise<void> | undefined;
  let usage = 0;
  let maintenance: Promise<void> | undefined;
  const retries = new Map<string, { at: number; failures: number }>();
  const index = new Map<string, { key: string; state: "pending" | "cache"; bytes: number; mtime: number }>();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const keyFor = (companyId: string, runId: string, chunkId: string) => {
    if (![companyId, runId, chunkId].every(value => UUID.test(value))) throw new Error("Invalid tool detail scope");
    return `${companyId}/${runId}/${chunkId}.json.gz`;
  };
  const local = (key: string, state: "pending" | "cache") =>
    path.join(options.basePath, ...key.split("/")) + `.${state}`;
  async function files() {
    const result: { key: string; state: "pending" | "cache"; bytes: number; mtime: number }[] = [];
    for (const company of await fs.readdir(options.basePath, { withFileTypes: true })) {
      if (!company.isDirectory() || !UUID.test(company.name)) continue;
      for (const run of await fs.readdir(path.join(options.basePath, company.name), { withFileTypes: true })) {
        if (!run.isDirectory() || !UUID.test(run.name)) continue;
        for (const file of await fs.readdir(path.join(options.basePath, company.name, run.name), { withFileTypes: true })) {
          if (file.isFile() && /^[a-f0-9-]{36}\.json\.gz\.pending\.[a-f0-9-]{36}\.tmp$/i.test(file.name)) {
            await fs.unlink(path.join(options.basePath, company.name, run.name, file.name));
            continue;
          }
          const match = /^([a-f0-9-]{36})\.json\.gz\.(pending|cache)$/i.exec(file.name);
          if (!file.isFile() || !match || !UUID.test(match[1]!)) continue;
          const key = keyFor(company.name, run.name, match[1]!);
          const state = match[2] as "pending" | "cache";
          const stat = await fs.stat(local(key, state));
          result.push({ key, state, bytes: stat.size, mtime: stat.mtimeMs });
        }
      }
    }
    return result;
  }
  function initialize() {
    return initialized ??= (async () => {
      await fs.mkdir(options.basePath, { recursive: true, mode: 0o700 });
      for (const file of await files()) { index.set(file.key, file); usage += file.bytes; }
      timer = setInterval(() => { void maintain().catch(error => {
        logger.warn({ err: error }, "Tool detail spool maintenance failed");
      }); }, options.intervalMs ?? 5000);
      timer.unref();
    })();
  }
  async function evict(required: number) {
    const cached = [...index.values()].filter(file => file.state === "cache").sort((a, b) => a.mtime - b.mtime);
    for (const file of cached) {
      if (usage + required <= maxBytes && now() - file.mtime < cacheGraceMs) continue;
      await fs.unlink(local(file.key, "cache"));
      usage -= file.bytes;
      index.delete(file.key);
    }
  }
  async function readBytes(key: string, remote = true) {
    for (const state of ["pending", "cache"] as const) {
      try { return await fs.readFile(local(key, state)); }
      catch (error) { if (!missing(error)) throw error; }
    }
    return remote ? options.archive?.get(key) ?? null : null;
  }
  async function append(companyId: string, runId: string, value: RunToolDetail): Promise<RunToolDetailRef | null> {
    const detail = runToolDetailSchema.parse(value);
    const key = keyFor(companyId, runId, detail.id);
    await initialize();
    return serial(async () => {
      const previous = await readBytes(key, false);
      if (previous) {
        const stored = JSON.parse(gunzipSync(previous, { maxOutputLength: MAX_CHUNK_BYTES }).toString("utf8")) as StoredDetail;
        if (JSON.stringify(stored.detail) !== JSON.stringify(detail)) throw new Error("Tool detail ID conflict");
        return { schema: "run_tool_detail_ref_v1", runId, chunkId: detail.id };
      }
      const record: StoredDetail = { companyId, runId, expiresAt: now() + RETENTION_MS, detail };
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > MAX_CHUNK_BYTES) throw new Error("Tool detail exceeds the storage limit");
      const bytes = gzipSync(serialized);
      if (bytes.length > MAX_CHUNK_BYTES) throw new Error("Tool detail chunk exceeds the storage limit");
      if (usage + bytes.length > maxBytes) await evict(bytes.length);
      if (usage + bytes.length > maxBytes) return null;
      const target = local(key, "pending");
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, target);
      } catch (error) {
        await fs.unlink(temporary).catch(cleanupError => { if (!missing(cleanupError)) throw cleanupError; });
        throw error;
      }
      usage += bytes.length;
      index.set(key, { key, state: "pending", bytes: bytes.length, mtime: now() });
      return { schema: "run_tool_detail_ref_v1", runId, chunkId: detail.id };
    });
  }
  async function maintain() {
    if (maintenance) return maintenance;
    maintenance = (async () => {
      await initialize();
      const pending = await serial(async () => {
        await evict(0);
        return [...index.values()].filter(file => file.state === "pending"
          && (retries.get(file.key)?.at ?? 0) <= now()).slice(0, 32);
      });
      if (!options.archive) return;
      for (let start = 0; start < pending.length; start += 4) {
        await Promise.all(pending.slice(start, start + 4).map(async file => {
          try {
            const bytes = await fs.readFile(local(file.key, "pending"));
            await options.archive!.put(file.key, bytes);
            await serial(async () => {
              await fs.utimes(local(file.key, "pending"), new Date(now()), new Date(now()));
              await fs.rename(local(file.key, "pending"), local(file.key, "cache"));
              index.set(file.key, { ...file, state: "cache", mtime: now() });
              retries.delete(file.key);
            });
          } catch (error) {
            const failures = (retries.get(file.key)?.failures ?? 0) + 1;
            retries.set(file.key, { failures, at: now() + Math.min(300_000, 5000 * 2 ** Math.min(failures - 1, 6)) });
            logger.warn({ err: error }, "Tool detail upload failed; pending chunk retained");
          }
        }));
      }
    })().finally(() => { maintenance = undefined; });
    return maintenance;
  }
  async function read(companyId: string, runId: string, reference: RunToolDetailRef, offset = 0, limit = 8192): Promise<RunToolDetailPage> {
    const ref = runToolDetailRefSchema.parse(reference);
    if (ref.runId !== runId) throw new Error("Tool detail run mismatch");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) {
      throw new Error("Invalid tool detail page");
    }
    const bytes = await readBytes(keyFor(companyId, runId, ref.chunkId));
    if (!bytes) return { status: "unavailable" };
    const stored = JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_CHUNK_BYTES }).toString("utf8")) as StoredDetail;
    if (stored.companyId !== companyId || stored.runId !== runId || stored.detail.id !== ref.chunkId) {
      throw new Error("Tool detail storage binding mismatch");
    }
    if (stored.expiresAt <= now()) return { status: "expired" };
    const detail = runToolDetailSchema.parse(stored.detail);
    return {
      status: "available", cwd: detail.cwd, durationMs: detail.durationMs, truncated: detail.truncated,
      input: detail.input?.slice(offset, offset + limit),
      output: detail.output?.slice(offset, offset + limit),
      error: detail.error?.slice(offset, offset + limit),
      ...(Math.max(detail.input?.length ?? 0, detail.output?.length ?? 0, detail.error?.length ?? 0) > offset + limit
        ? { nextOffset: offset + limit } : {}),
    };
  }
  return {
    append, read, maintain,
    async close() { if (timer) clearInterval(timer); await maintenance; await queue; },
  };
}

let store: ReturnType<typeof createRunToolDetailStore> | undefined;
export function getRunToolDetailStore() {
  return store ??= createRunToolDetailStore({
    basePath: process.env.RUN_TOOL_DETAILS_BASE_PATH
      ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-tool-details"),
    archive: process.env.RUN_TOOL_DETAILS_AZURE_CONTAINER_URL
      ? createAzureToolDetailArchive(process.env.RUN_TOOL_DETAILS_AZURE_CONTAINER_URL) : undefined,
  });
}
