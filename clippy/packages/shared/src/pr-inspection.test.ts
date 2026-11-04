import { describe, expect, it } from "vitest";
import { recordPrInspectionResultSchema } from "./pr-inspection.js";

const input = {
  schema: "pr_inspection_result_v1", outcome: "changes_requested",
  submissionId: `submission-publication-${"a".repeat(64)}`, reviewedCommit: "b".repeat(40),
  body: "## Changes requested\n\nFindings are presentation, not machine authority.",
};

describe("inspection result input", () => {
  it("accepts existing decision outcomes independently of findings formatting", () => {
    expect(recordPrInspectionResultSchema.parse(input).outcome).toBe("changes_requested");
    expect(recordPrInspectionResultSchema.parse({ ...input, outcome: "approved" }).outcome).toBe("approved");
  });
  it.each([
    { schema: "pr_inspection_result_v2" }, { outcome: "REQUEST_CHANGES" }, { reviewedCommit: "abc123" },
    { submissionId: "unbound-submission" }, { body: "" }, { body: "x".repeat(32001) },
    { inspectorAgentId: "11111111-1111-4111-8111-111111111111" },
    { runId: "11111111-1111-4111-8111-111111111111" },
  ])("rejects unsupported, ambiguous or caller-forged fields: %j", (override) => {
    expect(recordPrInspectionResultSchema.safeParse({ ...input, ...override }).success).toBe(false);
  });
});
