import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { RunToolDetail } from "@paperclipai/shared";
import { createAzureToolDetailArchive, createRunToolDetailStore } from "./run-tool-detail-store.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
function detail(overrides: Partial<RunToolDetail> = {}): RunToolDetail {
  return {
    version: 1, id: randomUUID(), callId: randomUUID(), phase: "end", name: "run_shell",
    summary: "Check SQL connectivity", ts: new Date().toISOString(), cwd: "workspace",
    output: "result", truncated: false, ...overrides,
  };
}
async function fixture(options: Partial<Parameters<typeof createRunToolDetailStore>[0]> = {}) {
  const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "tool-detail-"));
  cleanup.push(() => fs.rm(basePath, { recursive: true, force: true }));
  const config = { basePath, intervalMs: 60_000, ...options };
  const store = createRunToolDetailStore(config);
  cleanup.push(() => store.close());
  return { store, config, basePath, companyId: randomUUID(), runId: randomUUID() };
}

it("retains and pages immutable message parts without applying a preview truncation", async () => {
  const f = await fixture();
  const text = "First line\n" + "x".repeat(11500) + "\nLAST_LINE";
  const value = detail({ input: text, output: undefined, message: {
    id: randomUUID(), part: 0, last: true, label: "Assignment input", diagnostic: false,
  } });
  const ref = await f.store.append(f.companyId, f.runId, value);
  expect(ref).not.toBeNull();
  await f.store.close();
  const restarted = createRunToolDetailStore(f.config);
  cleanup.push(() => restarted.close());
  await expect(restarted.append(f.companyId, f.runId, value)).resolves.toEqual(ref);
  const first = await restarted.read(f.companyId, f.runId, ref!);
  const second = await restarted.read(f.companyId, f.runId, ref!, first.nextOffset!);
  expect(first.input! + second.input!).toBe(text);
  expect(second.input).toContain("LAST_LINE");
  expect(second.nextOffset).toBeUndefined();
  expect(first.truncated).toBe(false);
});

it("keeps failed uploads through restart, acknowledges immutable chunks, and reads paginated cloud details after cache cleanup", async () => {
  let time = Date.now(), failing = true;
  const objects = new Map<string, Buffer>();
  const put = vi.fn(async (key: string, value: Buffer) => {
    if (failing) throw new Error("offline");
    objects.set(key, value);
  });
  const f = await fixture({
    now: () => time, cacheGraceMs: 10,
    archive: { put, get: async key => objects.get(key) ?? null },
  });
  const value = detail({ input: "input", output: "abcdefghij" });
  const ref = await f.store.append(f.companyId, f.runId, value);
  expect(ref).not.toBeNull();
  await expect(f.store.append(f.companyId, f.runId, value)).resolves.toEqual(ref);
  await expect(f.store.append(f.companyId, f.runId, { ...value, output: "changed" })).rejects.toThrow("ID conflict");
  await f.store.maintain();
  expect(objects.size).toBe(0);
  await expect(f.store.read(f.companyId, f.runId, ref!, 0, 4)).resolves.toMatchObject({ input: "inpu", output: "abcd", nextOffset: 4 });
  await f.store.close();
  failing = false;
  const restarted = createRunToolDetailStore(f.config);
  cleanup.push(() => restarted.close());
  await restarted.maintain();
  expect(objects.size).toBe(1);
  time += 11;
  await restarted.maintain();
  expect(await fs.readdir(path.join(f.basePath, f.companyId, f.runId))).toEqual([]);
  await expect(restarted.read(f.companyId, f.runId, ref!, 4, 4)).resolves.toMatchObject({ output: "efgh", nextOffset: 8 });
  await expect(restarted.read(f.companyId, f.runId, ref!, 8, 4)).resolves.toMatchObject({ output: "ij" });
});

it("enforces the disk cap without deleting pending chunks and evicts acknowledged cache first", async () => {
  const objects = new Map<string, Buffer>();
  const f = await fixture({
    maxBytes: 2400,
    archive: { put: async (key, value) => { objects.set(key, value); }, get: async key => objects.get(key) ?? null },
  });
  const first = detail({ output: randomBytes(1600).toString("base64") });
  const ref = await f.store.append(f.companyId, f.runId, first);
  expect(ref).not.toBeNull();
  const second = detail({ output: randomBytes(1600).toString("base64") });
  expect(await f.store.append(f.companyId, f.runId, second)).toBeNull();
  await expect(f.store.read(f.companyId, f.runId, ref!)).resolves.toMatchObject({ status: "available", output: first.output });
  await f.store.maintain();
  expect(await f.store.append(f.companyId, f.runId, second)).not.toBeNull();
  const names = await fs.readdir(path.join(f.basePath, f.companyId, f.runId));
  expect(names).toHaveLength(1);
  expect(names[0]).toContain(second.id);
  await expect(f.store.read(f.companyId, f.runId, ref!)).resolves.toMatchObject({ status: "available" });
});

it("removes only abandoned unpublished temporary chunks on restart", async () => {
  const f = await fixture();
  const ref = await f.store.append(f.companyId, f.runId, detail());
  await f.store.close();
  const directory = path.join(f.basePath, f.companyId, f.runId);
  const abandoned = `${randomUUID()}.json.gz.pending.${randomUUID()}.tmp`;
  await fs.writeFile(path.join(directory, abandoned), "incomplete");
  await fs.writeFile(path.join(directory, "unrelated.tmp"), "preserve");
  const restarted = createRunToolDetailStore(f.config);
  cleanup.push(() => restarted.close());
  await restarted.maintain();
  expect(await fs.readdir(directory)).toEqual(expect.arrayContaining([
    `${ref!.chunkId}.json.gz.pending`, "unrelated.tmp",
  ]));
  expect(await fs.readdir(directory)).not.toContain(abandoned);
  await expect(restarted.read(f.companyId, f.runId, ref!)).resolves.toMatchObject({ status: "available" });
});

it("binds detail references to company and run, validates pages, and reports retention expiry without deleting unacknowledged chunks", async () => {
  let time = Date.now();
  const f = await fixture({ now: () => time });
  const ref = await f.store.append(f.companyId, f.runId, detail());
  await expect(f.store.read(randomUUID(), f.runId, ref!)).resolves.toEqual({ status: "unavailable" });
  await expect(f.store.read(f.companyId, randomUUID(), ref!)).rejects.toThrow("run mismatch");
  await expect(f.store.read("../outside", f.runId, ref!)).rejects.toThrow("scope");
  await expect(f.store.read(f.companyId, f.runId, ref!, -1)).rejects.toThrow("page");
  time += 31 * 24 * 60 * 60 * 1000;
  await expect(f.store.read(f.companyId, f.runId, ref!)).resolves.toEqual({ status: "expired" });
  await f.store.maintain();
  expect(await fs.readdir(path.join(f.basePath, f.companyId, f.runId))).toHaveLength(1);
});

it("uses Entra auth for immutable Azure chunks, verifies upload replay, and rejects redirects and oversized downloads", async () => {
  const bytes = Buffer.from("compressed fixture");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fetchObject = vi.fn<typeof fetch>();
  fetchObject.mockResolvedValueOnce(new Response(null, { status: 201 }))
    .mockResolvedValueOnce(new Response(null, { status: 412 }))
    .mockResolvedValueOnce(new Response(null, { status: 200, headers: { "x-ms-meta-sha256": digest } }))
    .mockResolvedValueOnce(new Response(bytes))
    .mockResolvedValueOnce(new Response(new Uint8Array(193 * 1024)));
  const archive = createAzureToolDetailArchive("https://fixture.blob.core.windows.net/diagnostics", {
    getToken: async () => "private-token", fetch: fetchObject,
  });
  const key = `${randomUUID()}/${randomUUID()}/${randomUUID()}.json.gz`;
  await archive.put(key, bytes);
  await archive.put(key, bytes);
  expect(fetchObject.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error", headers: { Authorization: "Bearer private-token", "If-None-Match": "*" },
  });
  expect(fetchObject.mock.calls[0]?.[0]).not.toContain("private-token");
  expect(await archive.get(key)).toEqual(bytes);
  await expect(archive.get(key)).rejects.toThrow("chunk limit");
  expect(() => createAzureToolDetailArchive("https://fixture.blob.core.windows.net/diagnostics?sig=secret")).toThrow("without credentials");
  expect(() => createAzureToolDetailArchive("https://outside.example/diagnostics")).toThrow("HTTPS URL");
});
