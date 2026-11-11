// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunToolDetailRef } from "@paperclipai/shared";
import { heartbeatsApi } from "../../api/heartbeats";
import { parseAgentPoolStdoutLine } from "../../adapters/agent-pool";
import { RunTranscriptView } from "./RunTranscriptView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const runId = "11111111-1111-4111-8111-111111111111";
const callId = "22222222-2222-4222-8222-222222222222";
const startRef: RunToolDetailRef = { schema: "run_tool_detail_ref_v1", runId, chunkId: "33333333-3333-4333-8333-333333333333" };
const endRef: RunToolDetailRef = { ...startRef, chunkId: "44444444-4444-4444-8444-444444444444" };
function entry(phase: "start" | "end", overrides = {}) {
  return parseAgentPoolStdoutLine(JSON.stringify({
    type: "clippy.tool", callId, phase, name: "run_shell", summary: "Check SQL connectivity",
    isError: false, detailRef: phase === "start" ? startRef : endRef, detailStatus: "available",
    ...(phase === "end" ? { durationMs: 125 } : {}), ...overrides,
  }), "2026-09-01T00:00:00.000Z");
}

it("loads only selected details, updates the same row on completion, and paginates without reloading input", async () => {
  const load = vi.spyOn(heartbeatsApi, "toolDetail").mockImplementation(async (reference, offset) =>
    reference.chunkId === startRef.chunkId
      ? { status: "available", input: '{"command":"Check-Sql"}', cwd: "workspace" }
      : offset ? { status: "available", output: "last page" }
        : { status: "available", output: "first page ", nextOffset: 8192 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    const start = entry("start");
    await act(async () => root.render(<RunTranscriptView entries={start} streaming />));
    expect(container.textContent).toContain("run_shell");
    expect(container.textContent).toContain("running");
    expect(container.textContent).not.toContain("Check SQL connectivity");
    expect(load).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand tool details"]')!.click());
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Check-Sql");
    await act(async () => root.render(<RunTranscriptView entries={[...start, ...entry("end")]} streaming />));
    expect(container.querySelectorAll('[aria-label="Collapse tool details"]')).toHaveLength(1);
    expect(container.textContent).toContain("125 ms");
    expect(container.textContent).toContain("first page");
    expect(load).toHaveBeenCalledTimes(2);
    const more = [...container.querySelectorAll("button")].find(button => button.textContent === "Load more")!;
    await act(async () => more.click());
    expect(container.textContent).toContain("first page last page");
    expect(load).toHaveBeenLastCalledWith(endRef, 8192, expect.anything());
    expect(load).toHaveBeenCalledTimes(3);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps failed tool bodies collapsed and shows unavailable details explicitly on selection", async () => {
  const load = vi.spyOn(heartbeatsApi, "toolDetail");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RunTranscriptView entries={entry("end", {
      isError: true, detailRef: null, detailStatus: "unavailable",
    })} />));
    expect(container.textContent).not.toContain("not retained");
    expect(load).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand tool details"]')!.click());
    expect(container.textContent).toContain("not retained");
    expect(container.textContent).not.toContain("Waiting for result...");
    expect(load).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it.each(["run_shell", "shell"])("shows remote %s input on hover or focus without opening the tool or loading its result", async name => {
  const load = vi.spyOn(heartbeatsApi, "toolDetail").mockImplementation(async reference =>
    reference.chunkId === startRef.chunkId
      ? { status: "available", input: '{"command":"Full command before expansion"}' }
      : { status: "available", output: "Result stays collapsed" });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<RunTranscriptView entries={[...entry("start", { name }), ...entry("end", { name })]} />));
    const header = container.querySelector<HTMLButtonElement>('[aria-label="Expand tool details"]')!;
    expect(load).not.toHaveBeenCalled();
    await act(async () => header.focus());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.textContent).toContain("Full command before expansion");
    expect(document.body.textContent).not.toContain("Result stays collapsed");
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith(startRef, 0, expect.anything());
    await act(async () => header.click());
    expect(container.textContent).toContain("Result stays collapsed");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
