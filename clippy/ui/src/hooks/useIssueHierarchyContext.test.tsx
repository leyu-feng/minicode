// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIssueHierarchyContext } from "./useIssueHierarchyContext";

const { getIssue, listIssues } = vi.hoisted(() => ({ getIssue: vi.fn(), listIssues: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { get: getIssue, list: listIssues } }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("task hierarchy ancestor loading", () => {
  afterEach(() => vi.resetAllMocks());

  it.each([false, true])("stops at a hidden ancestor without fetching its parent (hidden: %s)", async (hidden) => {
    const matches = [{ id: "child", parentId: "parent", companyId: "company" } as Issue];
    getIssue.mockImplementation(async (id: string) => ({
      id, companyId: "company", parentId: id === "parent" ? "grandparent" : null,
      hiddenAt: hidden && id === "parent" ? new Date() : null,
    }));
    listIssues.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    function Hierarchy() {
      const { issues } = useIssueHierarchyContext("company", matches, [], true, 10);
      return <div>{issues.map((issue) => issue.id).join(",")}</div>;
    }
    try {
      await act(async () => {
        root.render(<QueryClientProvider client={client}><Hierarchy /></QueryClientProvider>);
      });
      await act(async () => {
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      });
      expect(getIssue.mock.calls.map(([id]) => id)).toEqual(hidden ? ["parent"] : ["parent", "grandparent"]);
      expect(container.textContent).toBe(hidden ? "" : "parent,grandparent");
    } finally {
      await act(async () => root.unmount());
      client.clear();
    }
  });
});
