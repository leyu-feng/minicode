import type { AgentPool, AgentPoolWorker, AgentPoolPairing } from "@paperclipai/shared";
import { api } from "./client";

const base = (companyId: string) => `/companies/${companyId}/agent-pools`;
export const agentPoolsApi = {
  list: (companyId: string) => api.get<AgentPool[]>(base(companyId)),
  create: (companyId: string, name: string) => api.post<AgentPool>(base(companyId), { name }),
  workers: (companyId: string, poolId: string) =>
    api.get<AgentPoolWorker[]>(`${base(companyId)}/${poolId}/workers`),
  pair: (companyId: string, poolId: string, name: string) =>
    api.post<AgentPoolPairing>(`${base(companyId)}/${poolId}/workers`, { name }),
  revoke: (companyId: string, poolId: string, workerId: string) =>
    api.delete<void>(`${base(companyId)}/${poolId}/workers/${workerId}`),
};
