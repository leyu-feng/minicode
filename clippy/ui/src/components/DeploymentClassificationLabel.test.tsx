// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthStatus } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { DeploymentClassificationLabel } from "./DeploymentClassificationLabel";

describe("DeploymentClassificationLabel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
    vi.unstubAllGlobals();
  });

  async function setLabel(classificationLabel?: string) {
    await act(async () => {
      client.setQueryData<HealthStatus>(queryKeys.health, { status: "ok", classificationLabel });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function render(classificationLabel?: string) {
    await setLabel(classificationLabel);
    await act(async () => root.render(
      <QueryClientProvider client={client}><DeploymentClassificationLabel /></QueryClientProvider>,
    ));
  }

  it.each([undefined, "", " \t "])("does not render for an unset or blank label (%s)", async (label) => {
    await render(label);
    expect(container.childElementCount).toBe(0);
  });

  it("shows the configured label beside its shield icon with full text available on hover", async () => {
    await render("Highly Confidential\\Contoso FTE");
    const label = container.querySelector('[role="note"]');
    expect(label?.textContent).toBe("Highly Confidential\\Contoso FTE");
    expect(label?.getAttribute("title")).toBe("Highly Confidential\\Contoso FTE");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("updates and removes the notice when the shared health metadata changes", async () => {
    await render("Highly Confidential\\Contoso FTE");
    await setLabel("Internal");
    expect(container.textContent).toBe("Internal");
    await setLabel("");
    expect(container.childElementCount).toBe(0);
  });
});
