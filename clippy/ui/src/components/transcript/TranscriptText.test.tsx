// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RunMessageSummary, RunToolDetailPage } from "@paperclipai/shared";
import { TranscriptText } from "./TranscriptText";
import { RunTranscriptView } from "./RunTranscriptView";

const { toolDetail } = vi.hoisted(() => ({ toolDetail: vi.fn() }));
vi.mock("../../api/heartbeats", () => ({ heartbeatsApi: { toolDetail } }));
vi.mock("../MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  toolDetail.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function render(element: ReactNode) {
  await act(async () => root.render(element));
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(item => item.textContent?.includes(label));
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
function part(index: number, last = true): RunMessageSummary {
  return {
    type: "clippy.message",
    message: { id: "11111111-1111-4111-8111-111111111111", part: index, last, label: "Assignment input", diagnostic: false },
    summary: "First line",
    detailRef: { schema: "run_tool_detail_ref_v1", runId: "22222222-2222-4222-8222-222222222222",
      chunkId: index ? "44444444-4444-4444-8444-444444444444" : "33333333-3333-4333-8333-333333333333" },
    detailStatus: "available",
  };
}

it("collapses multiline messages, expands all, and preserves a reader's choice through streaming updates", async () => {
  const entries = [{ kind: "assistant" as const, ts: "2026-11-11T00:00:00Z", text: "First line\nHidden body" }];
  await render(<RunTranscriptView entries={entries} streaming />);
  expect(host.textContent).not.toContain("Hidden body");
  await click("Expand all messages");
  expect(host.textContent).toContain("Hidden body");
  await click("First line");
  expect(host.textContent).not.toContain("Hidden body");
  await render(<RunTranscriptView entries={[{ ...entries[0], text: "First line\nHidden body\nNew delta" }]} streaming />);
  expect(host.textContent).not.toContain("New delta");
  await click("Collapse all messages");
  await click("Expand all messages");
  expect(host.textContent).toContain("New delta");
});

it("loads every page and part after one expansion, then copies the complete message without a load-more action", async () => {
  const first = "First line\n" + "x".repeat(15000);
  const tail = "\nLAST_MESSAGE_LINE";
  toolDetail.mockImplementation(async (reference, offset): Promise<RunToolDetailPage> => {
    const text = reference.chunkId.startsWith("333") ? first : tail;
    return { status: "available", input: text.slice(offset, offset + 8192),
      ...(text.length > offset + 8192 ? { nextOffset: offset + 8192 } : {}) };
  });
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const entries = [part(0, false), part(1)].map(value => ({
    kind: "stdout" as const, ts: "2026-11-11T00:00:00Z", text: JSON.stringify(value),
  }));
  await render(<RunTranscriptView entries={entries} />);
  expect(toolDetail).not.toHaveBeenCalled();
  expect(host.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
  await click("Assignment input");
  expect(toolDetail).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain("LAST_MESSAGE_LINE");
  expect(host.textContent).not.toMatch(/Load more|message truncated/);
  await click("Copy full message");
  expect(writeText).toHaveBeenCalledWith(first + tail);
});

it("reports a failed detail read and retries rather than presenting a preview as the full message", async () => {
  toolDetail.mockRejectedValueOnce(new Error("Storage offline"))
    .mockResolvedValue({ status: "available", input: "Full message recovered" });
  await render(<TranscriptText text="First line" parts={[part(0)]} />);
  await click("First line");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Storage offline");
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Copy full message")?.disabled).toBe(true);
  await click("Retry loading message");
  expect(host.textContent).toContain("Full message recovered");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("aborts full-message reads when collapsed", async () => {
  let resolve!: (value: RunToolDetailPage) => void;
  toolDetail.mockReturnValue(new Promise<RunToolDetailPage>(done => { resolve = done; }));
  await render(<TranscriptText text="First line" parts={[part(0)]} />);
  await click("First line");
  const signal = toolDetail.mock.calls[0][2].signal as AbortSignal;
  await click("First line");
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ status: "available", input: "Late content" }));
  expect(host.textContent).not.toContain("Late content");
});

it.each([false, true])("makes historical capture loss explicit rather than offering another truncation expander (markdown: %s)", async markdown => {
  await render(<TranscriptText text={"[pi] # assignment input\n[pi] preview\n[pi] [message truncated]\n"} markdown={markdown} />);
  await click("assignment input");
  expect(host.textContent).toContain("Only the captured preview is available");
  expect(host.textContent).not.toContain("[message truncated]");
});

it.each(["missing", "expired"])("reports %s retained content instead of silently showing an empty full message", async status => {
  toolDetail.mockResolvedValue({ status });
  await render(<TranscriptText text="First line" parts={[part(0)]} />);
  await click("First line");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(`Message content is ${status}`);
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Copy full message")?.disabled).toBe(true);
});

it("reports missing terminal parts as capture loss instead of waiting forever on a finished run", async () => {
  toolDetail.mockResolvedValue({ status: "available", input: "First retained part" });
  await render(<TranscriptText text="First line" parts={[part(0, false)]} />);
  await click("First line");
  expect(host.textContent).toContain("Some message content was not retained");
  expect(host.textContent).not.toContain("Waiting");
  expect([...host.querySelectorAll("button")].find(button => button.textContent === "Copy full message")?.disabled).toBe(true);
});
