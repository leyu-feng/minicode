import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { includeIssueHierarchyContext, loadIssueHierarchyChildren } from "./issue-hierarchy-context";

const task = (id: string, parentId: string | null = null) => ({ id, parentId, companyId: "company" } as Issue);

describe("task hierarchy context", () => {
  it("retains ancestors and descendants without promoting siblings or orphans", () => {
    const match = task("human", "agent-parent");
    const context = [task("agent-parent", "grandparent"), task("grandparent"), task("agent-child", "human"), task("grandchild", "agent-child"), task("unrelated"), task("orphan", "missing"), task("sibling", "agent-parent")];
    expect(includeIssueHierarchyContext([match], context).map((issue) => issue.id)).toEqual([
      "human", "agent-parent", "grandparent", "agent-child", "grandchild",
    ]);
    expect(includeIssueHierarchyContext([], context)).toEqual([]);
  });
  it("deduplicates matches and terminates cycles", () => {
    const match = task("human", "parent");
    expect(includeIssueHierarchyContext([match], [match, task("parent", "human")]).map((issue) => issue.id)).toEqual(["human", "parent"]);
  });
  it("omits hidden ancestors and stale hidden matches without hiding independently visible children", () => {
    const hiddenParent = { ...task("hidden-parent", "grandparent"), hiddenAt: new Date() };
    const child = task("child", hiddenParent.id);
    expect(includeIssueHierarchyContext([child], [hiddenParent, task("grandparent")]).map((issue) => issue.id))
      .toEqual(["child"]);
    expect(includeIssueHierarchyContext([hiddenParent], [task("grandchild", hiddenParent.id)])).toEqual([]);
    expect(includeIssueHierarchyContext([task("root")], [
      { ...task("hidden-child", "root"), hiddenAt: new Date() }, task("grandchild", "hidden-child"),
    ]).map((issue) => issue.id)).toEqual(["root"]);
  });
});

describe("bounded hierarchy reads", () => {
  it("caps rows and requests, and shares overlapping matching subtrees", async () => {
    const root = task("root");
    const child = task("child", "root");
    const calls: string[] = [];
    const read = async (id: string, limit: number, offset: number) => {
      calls.push(id);
      const rows = id === "root" ? [child] : id === "child"
        ? Array.from({ length: 500 }, (_, index) => task(`nested-${index}`, "child")) : [];
      return rows.slice(offset, offset + limit);
    };
    const first = await loadIssueHierarchyChildren("company", [root, child], [], 5, read);
    expect(first.issues).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(calls).toEqual(["root", "child"]);
    calls.length = 0;
    expect((await loadIssueHierarchyChildren("company", [root, child], [], 10, read)).issues).toHaveLength(10);
    expect(calls).toEqual(["root", "child"]);
  });
  it("probes collapsed parents without fetching their tree and rejects foreign-company rows", async () => {
    const calls: Array<[string, number]> = [];
    const rows = await loadIssueHierarchyChildren("company", [task("root")], ["root"], 5,
      async (id, limit) => { calls.push([id, limit]); return [task("child", "root")]; });
    expect(rows.issues.map((issue) => issue.id)).toEqual(["child"]);
    expect(calls).toEqual([["root", 1]]);
    expect(await loadIssueHierarchyChildren("company", [task("root")], [], 1,
      async () => [{ ...task("foreign", "root"), companyId: "other" }])).toEqual({ issues: [], hasMore: true });
  });
  it("does not fetch hidden matches or expand hidden children returned by a stale read", async () => {
    const calls: string[] = [];
    const result = await loadIssueHierarchyChildren("company", [task("root"), {
      ...task("hidden-root"), hiddenAt: new Date(),
    }], [], 5, async (id) => {
      calls.push(id);
      return [{ ...task("hidden-child", id), hiddenAt: new Date() }];
    });
    expect(calls).toEqual(["root"]);
    expect(result.issues).toEqual([]);
  });
});
