// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, it } from "vitest";
import { TooltipProvider } from "../../components/ui/tooltip";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { agentPoolUIAdapter } from "./index";
import type { CreateConfigValues } from "../types";

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });

it.each([undefined, "claude-opus-4.6"])("builds the Claude default without overwriting an explicit model (%s)", harnessModel => {
  expect(agentPoolUIAdapter.buildAdapterConfig({
    ...defaultCreateValues, adapterSchemaValues: { harness: "claudecode", harnessModel },
  })).toMatchObject({ harness: "claudecode", harnessModel: harnessModel ?? "claude-sonnet-5" });
});

it.each(["create", "edit"] as const)("preserves an explicit model and resets cross-harness defaults in %s mode", async mode => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(["agent-pools", "company"], [{ id: "pool", name: "default", type: "hosted" }]);
  client.setQueryData(["agent-pools", "company", "pool", "harnesses"], [
    { id: "claudecode", name: "Claude Code" }, { id: "copilotcli", name: "Copilot CLI" },
  ]);
  client.setQueryData(["agent-pools", "company", "pool", "repos"], []);
  const initial = { name: "default", harness: "claudecode", harnessModel: "claude-opus-4.6" };
  let saved: Record<string, unknown> = {};
  const ConfigFields = agentPoolUIAdapter.ConfigFields;
  function Fixture() {
    const [config, setConfig] = useState<Record<string, unknown>>(initial);
    const [values, setValues] = useState<CreateConfigValues>({ ...defaultCreateValues, adapterSchemaValues: initial });
    saved = mode === "create" ? agentPoolUIAdapter.buildAdapterConfig(values) : config;
    return <ConfigFields mode={mode} isCreate={mode === "create"} adapterType="agent_pool" companyId="company"
      values={mode === "create" ? values : null}
      set={patch => setValues(previous => ({ ...previous, ...patch }))}
      config={config} eff={(_group, _field, original) => original}
      mark={(_group, field, value) => setConfig(previous => ({ ...previous, [field]: value }))}
      models={[]} />;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><Fixture /></TooltipProvider></QueryClientProvider>));
    const model = () => container.querySelector<HTMLInputElement>('input[placeholder="claude-sonnet-5"]')?.value;
    expect(model()).toBe("claude-opus-4.6");
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Harness"]')!;
    await act(async () => {
      select.value = "copilotcli";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saved).toMatchObject({ harness: "copilotcli" });
    expect(saved.harnessModel).toBeUndefined();
    await act(async () => {
      select.value = "claudecode";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saved).toMatchObject({ harness: "claudecode", harnessModel: "claude-sonnet-5" });
    expect(model()).toBe("claude-sonnet-5");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
