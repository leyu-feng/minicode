import { ManagedIdentityCredential } from "@azure/identity";
import { z } from "zod";
import {
  hostedWorkerConfigSchema, hostedWorkerRepositoriesSchema, hostedWorkerStatusSchema,
  hostedWorkerDemandSchema,
  type HostedWorkerConfig,
} from "@paperclipai/shared";
import { guardedRemoteHttpFetch } from "./remote-http-fetch.js";

let credential: ManagedIdentityCredential | undefined;
export function defaultHostedWorkerConfig(): HostedWorkerConfig | null {
  const apiUrl = process.env.PAPERCLIP_HOSTED_WORKER_URL;
  const audience = process.env.PAPERCLIP_HOSTED_WORKER_AUDIENCE;
  if (!apiUrl && !audience) return null;
  return hostedWorkerConfigSchema.parse({ apiUrl, audience });
}

export function hostedWorkerClient(config: HostedWorkerConfig) {
  const validated = hostedWorkerConfigSchema.parse(config);
  const base = validated.apiUrl.replace(/\/+$/, "");
  async function request(method: string, path: string, expected: number, body?: unknown, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(10_000);
    const abortSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    credential ??= new ManagedIdentityCredential(process.env.AZURE_CLIENT_ID
      ? { clientId: process.env.AZURE_CLIENT_ID } : {});
    const token = await credential.getToken(`${validated.audience.replace(/\/+$/, "").replace(/\/\.default$/, "")}/.default`,
      { abortSignal });
    const response = await guardedRemoteHttpFetch(`${base}${path}`, {
      method, signal: abortSignal, redirect: "error",
      headers: { Authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, {
      allowPrivateNetwork: true,
      error: (message) => new Error(`Hosted worker provider: ${message}`),
    });
    if (response.status !== expected) {
      await response.body?.cancel();
      throw new Error(`Hosted worker provider returned HTTP ${response.status}; expected ${expected}.`);
    }
    return response;
  }
  const path = (poolId: string) => `/${z.string().uuid().parse(poolId)}`;
  return {
    async create(companyId: string, name: string, signal?: AbortSignal) {
      const response = await request("POST", "", 201, { companyId, name }, signal);
      const pool = z.object({ poolId: z.string().uuid(), companyId: z.string().uuid(), name: z.string() }).parse(await response.json());
      if (pool.companyId !== companyId || pool.name !== name) throw new Error("Hosted provider returned a pool for a different company or name.");
      return pool.poolId;
    },
    async status(poolId: string, signal?: AbortSignal) {
      return hostedWorkerStatusSchema.parse(await (await request("GET", `${path(poolId)}/status`, 200, undefined, signal)).json());
    },
    async repositories(poolId: string, signal?: AbortSignal) {
      return hostedWorkerRepositoriesSchema.parse(await (await request("GET", `${path(poolId)}/repos`, 200, undefined, signal)).json());
    },
    async report(poolId: string, itemsWaiting: number, signal?: AbortSignal) {
      await request("POST", path(poolId), 202, hostedWorkerDemandSchema.parse({ itemsWaiting }), signal);
    },
    async delete(poolId: string) { await request("DELETE", path(poolId), 204); },
  };
}
