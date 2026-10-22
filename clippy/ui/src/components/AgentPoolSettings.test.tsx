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
const freelance = { type: "freelance" as const, hostedApiUrl: null, hostedAudience: null, hostedPoolId: null };
beforeEach(() => { vi.spyOn(agentPoolsApi, "defaults").mockResolvedValue(null); });
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
      ...freelance, id: "hosted", companyId: "company", name: "default", type: "hosted",
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
    vi.spyOn(agentPoolsApi, "list").mockResolvedValue([{ ...freelance, id: "default-pool", companyId: "company", name: "default" }]);
    vi.spyOn(agentPoolsApi, "workers").mockResolvedValue([]);
    const create = vi.spyOn(agentPoolsApi, "create").mockResolvedValue({ ...freelance, id: "new-pool", companyId: "company", name: "coding" });
    const pair = vi.spyOn(agentPoolsApi, "pair").mockResolvedValue({
      workerId: "worker-id", serverToken: "one-time-fixture", expiresAt: "2026-10-17T12:00:00Z",
    });
    await mount();
    await input("New pool name", "coding");
    await click("Create pool");
    expect(create).toHaveBeenCalledWith("company", "coding");
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

  it("shows failed pool loading rather than implying an empty successful inventory", async () => {
    vi.spyOn(agentPoolsApi, "list").mockRejectedValue(new Error("Company access denied"));
    await mount();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Company access denied");
  });
});
