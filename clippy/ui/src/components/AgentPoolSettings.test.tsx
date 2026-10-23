// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPoolSettings } from "./AgentPoolSettings";
import { agentPoolsApi } from "../api/agent-pools";
import { agentPoolUIAdapter } from "../adapters/agent-pool";
import { defaultCreateValues } from "./agent-config-defaults";
import { HostedRepositorySelect } from "./HostedRepositorySelect";

let root: Root | undefined;
let client: QueryClient | undefined;
let container: HTMLDivElement;
const devbox = { type: "devbox" as const, hostedApiUrl: null, hostedAudience: null, hostedPoolId: null };
const hosted = { ...devbox, type: "hosted" as const, id: "default-pool", companyId: "company", name: "default" };
beforeEach(() => {
  vi.spyOn(agentPoolsApi, "status").mockResolvedValue({ activeWorkers: 1, provisioningWorkers: 1, isMock: false });
  vi.spyOn(agentPoolsApi, "repositories").mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  container?.remove();
  vi.restoreAllMocks();
});

async function mount(content: ReactNode = <AgentPoolSettings companyId="company" />) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root!.render(
    <QueryClientProvider client={client!}>{content}</QueryClientProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

async function input(label: string, text: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text)!;
  await act(async () => button.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}

describe("AgentPool settings", () => {
  it("defaults the Hosted primary and lets every catalog repository be primary without duplicating references", async () => {
    vi.spyOn(agentPoolsApi, "list").mockResolvedValue([{
      ...hosted,
    }]);
    vi.spyOn(agentPoolsApi, "repositories").mockResolvedValue([
      { id: "main", name: "Main", branch: "main", isDefault: true },
      { id: "other", name: "Other", branch: "release", isDefault: false },
    ]);
    const onChange = vi.fn();
    await mount(<HostedRepositorySelect companyId="company" poolName="default" referenceIds={["other"]} onChange={onChange} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    const primary = container.querySelector<HTMLSelectElement>('select[aria-label="Primary repository"]')!;
    expect(primary.value).toBe("main");
    expect(primary.options).toHaveLength(2);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    await act(async () => {
      primary.value = "other";
      primary.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("other", []);
  });

  it("creates a pool, pairs a worker, and dismisses the one-time token without persisting it in adapter config", async () => {
    const list = vi.spyOn(agentPoolsApi, "list").mockResolvedValue([hosted]);
    vi.spyOn(agentPoolsApi, "workers").mockResolvedValue([]);
    const newPool = { ...devbox, id: "new-pool", companyId: "company", name: "coding" };
    const create = vi.spyOn(agentPoolsApi, "create").mockImplementation(async () => {
      list.mockResolvedValue([hosted, newPool]);
      return newPool;
    });
    const pair = vi.spyOn(agentPoolsApi, "pair").mockResolvedValue({
      workerId: "worker-id", serverToken: "one-time-fixture", expiresAt: "2026-10-17T12:00:00Z",
    });
    await mount();
    await input("New pool name", "coding");
    await click("Create pool");
    expect(create).toHaveBeenCalledWith("company", "coding");
    expect(container.textContent).toContain("coding (Devbox)");
    await input("Worker name", "dev-machine");
    await click("Pair worker");
    expect(pair).toHaveBeenCalledWith("company", "new-pool", "dev-machine");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Pairing token"]')?.value).toBe("one-time-fixture");
    expect(container.textContent).toContain("--worker-id worker-id");
    await click("Dismiss token");
    expect(container.querySelector('[aria-label="Pairing token"]')).toBeNull();
    expect(agentPoolUIAdapter.buildAdapterConfig({
      ...defaultCreateValues, adapterSchemaValues: { name: "coding" },
    })).toEqual({ name: "coding" });
  });

  it("shows Hosted capacity without type switching, provider fields, manual pairing, or backlog controls", async () => {
    vi.spyOn(agentPoolsApi, "list").mockResolvedValue([hosted]);
    vi.spyOn(agentPoolsApi, "workers").mockResolvedValue([]);
    await mount();
    expect(container.textContent).toContain("default (Hosted)");
    expect(container.textContent).toContain("built-in agent host");
    expect(container.textContent).toContain("1 active, 1 provisioning");
    expect(container.textContent).toContain("No active workers connected.");
    for (const label of ["Pool type", "Provider API URL", "Provider token audience", "Worker name", "Tasks waiting"]) {
      expect(container.querySelector(`[aria-label="${label}"]`)).toBeNull();
    }
    expect(container.textContent).not.toContain("Clear all existing worker pairings");
  });

  it("defaults to active workers and filters disconnected, reconnecting, unpaired, and revoked workers", async () => {
    vi.spyOn(agentPoolsApi, "list").mockResolvedValue([hosted]);
    const worker = { poolId: hosted.id, paired: true, revoked: false };
    vi.spyOn(agentPoolsApi, "workers").mockResolvedValue([
      { ...worker, id: "idle", name: "connected-idle", status: "idle" },
      { ...worker, id: "busy", name: "connected-busy", status: "busy" },
      { ...worker, id: "offline", name: "disconnected-offline", status: "offline" },
      { ...worker, id: "reconnecting", name: "disconnected-reconnecting", status: "reconnecting" },
      { ...worker, id: "pending", name: "unpaired-worker", status: "offline", paired: false },
      { ...worker, id: "revoked", name: "revoked-worker", status: "busy", revoked: true },
    ]);
    await mount();
    const filter = container.querySelector<HTMLSelectElement>('[aria-label="Worker filter"]')!;
    expect(filter.value).toBe("active");
    expect(container.textContent).toContain("connected-idle:");
    expect(container.textContent).toContain("connected-busy:");
    expect(container.textContent).not.toContain("disconnected-offline:");
    expect(container.textContent).not.toContain("disconnected-reconnecting:");
    expect(container.textContent).not.toContain("unpaired-worker:");
    expect(container.textContent).not.toContain("revoked-worker:");
    for (const value of ["disconnected", "revoked", "all"]) {
      await act(async () => {
        filter.value = value;
        filter.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (value !== "revoked") {
        expect(container.textContent).toContain("disconnected-offline:");
        expect(container.textContent).toContain("disconnected-reconnecting:");
        expect(container.textContent).toContain("unpaired-worker:");
      } else {
        expect(container.textContent).not.toContain("disconnected-offline:");
      }
      if (value !== "disconnected") expect(container.textContent).toContain("revoked-worker:");
      else expect(container.textContent).not.toContain("revoked-worker:");
      if (value === "all") expect(container.textContent).toContain("connected-idle:");
      else expect(container.textContent).not.toContain("connected-idle:");
    }
  });

  it("surfaces a built-in host failure and retries without a settings form", async () => {
    vi.spyOn(agentPoolsApi, "list").mockResolvedValue([hosted]);
    vi.spyOn(agentPoolsApi, "workers").mockResolvedValue([]);
    vi.mocked(agentPoolsApi.status).mockRejectedValueOnce(new Error("Built-in agent host unavailable"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Built-in agent host unavailable");
    await click("Retry Hosted connection");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("1 active, 1 provisioning");
  });

  it("shows failed pool loading rather than implying an empty successful inventory", async () => {
    vi.spyOn(agentPoolsApi, "list").mockRejectedValue(new Error("Company access denied"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Company access denied");
  });
});
