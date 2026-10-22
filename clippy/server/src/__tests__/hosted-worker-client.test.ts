import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedWorkerConfigSchema } from "@paperclipai/shared";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";
import { hostedWorkerClient } from "../services/hosted-worker-client.js";

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: class { getToken = getToken; },
}));
vi.mock("../services/remote-http-fetch.js", () => ({ guardedRemoteHttpFetch: vi.fn() }));

const config = { apiUrl: "https://provider.example/v1/hosted-worker/", audience: "api://provider" };
const fetch = vi.mocked(guardedRemoteHttpFetch);
beforeEach(() => {
  vi.clearAllMocks();
  getToken.mockResolvedValue({ token: "fixture-mi-token", expiresOnTimestamp: Date.now() + 60_000 });
});

describe("Hosted worker managed identity client", () => {
  it("uses the singular API and returned provider ID, without following token-bearing redirects", async () => {
    const companyId = randomUUID();
    const poolId = randomUUID();
    fetch.mockResolvedValueOnce(Response.json({ poolId, companyId, name: "default" }, { status: 201 }));
    const client = hostedWorkerClient(config);
    expect(await client.create(companyId, "default")).toBe(poolId);
    expect(getToken).toHaveBeenCalledWith("api://provider/.default", { abortSignal: expect.any(AbortSignal) });
    expect(fetch).toHaveBeenLastCalledWith("https://provider.example/v1/hosted-worker", expect.objectContaining({
      method: "POST", redirect: "error", headers: expect.objectContaining({ Authorization: "Bearer fixture-mi-token" }),
      body: JSON.stringify({ companyId, name: "default" }), signal: expect.any(AbortSignal),
    }), expect.objectContaining({ allowPrivateNetwork: true, error: expect.any(Function) }));
    fetch.mockResolvedValueOnce(new Response(null, { status: 202 }));
    await client.report(poolId, 4);
    expect(fetch).toHaveBeenLastCalledWith(`https://provider.example/v1/hosted-worker/${poolId}`,
      expect.objectContaining({ method: "POST", body: '{"itemsWaiting":4}' }), expect.any(Object));
    fetch.mockResolvedValueOnce(Response.json({ activeWorkers: 5, provisioningWorkers: 1, isMock: true }));
    expect(await client.status(poolId)).toEqual({ activeWorkers: 5, provisioningWorkers: 1, isMock: true });
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.delete(poolId);
  });

  it("rejects malformed responses, invalid demand, mismatched ownership and invalid catalogs", async () => {
    const client = hostedWorkerClient(config);
    const poolId = randomUUID();
    await expect(client.report(poolId, -1)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(Response.json({ poolId, companyId: randomUUID(), name: "default" }, { status: 201 }));
    await expect(client.create(randomUUID(), "default")).rejects.toThrow("different company");
    fetch.mockResolvedValueOnce(Response.json({ activeWorkers: -1, provisioningWorkers: 1, isMock: true }));
    await expect(client.status(poolId)).rejects.toThrow();
    fetch.mockResolvedValueOnce(Response.json([
      { id: "a", name: "A", branch: "main", isDefault: true },
      { id: "b", name: "B", branch: "main", isDefault: true },
    ]));
    await expect(client.repositories(poolId)).rejects.toThrow("exactly one default");
    fetch.mockResolvedValueOnce(new Response("private provider details", { status: 403 }));
    await expect(client.status(poolId)).rejects.toThrow("HTTP 403; expected 200");
  });

  it("validates provider endpoints safely while the URL field is incomplete", () => {
    for (const apiUrl of ["", "http://provider.example/v1/hosted-worker", "not-a-url",
      "https://user:password@provider.example/v1/hosted-worker", "https://provider.example/v1/hosted-worker?token=x"]) {
      expect(hostedWorkerConfigSchema.safeParse({ ...config, apiUrl }).success).toBe(false);
    }
  });
});
