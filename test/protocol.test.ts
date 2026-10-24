import test from "node:test";
import assert from "node:assert/strict";
import { job, result } from "./helpers.js";
import { parseResult, validateResult, MAX_RESULT } from "../src/protocol.js";
import { parseArgs, selectReviewers, aggregate, renderReport } from "../src/report.js";
import { severities, type Result, type Outcome } from "../src/types.js";

test("argument validation rejects invalid/missing/duplicate flags and unexpected words", () => {
  assert.equal(parseArgs("").minimumSeverity, "medium");
  for (const severity of severities) assert.equal(parseArgs(`--min-severity ${severity} --base origin/main`).minimumSeverity, severity);
  for (const input of ["--min-severity", "--min-severity urgent", "--base", "--base --min-severity high", "oops", "--unknown x", "--min-severity HIGH", "--base main extra", "--base main --base other"]) assert.throws(() => parseArgs(input), /Usage/);
});
test("strict result validation accepts captured new and deleted old locations", () => {
  const j = job(), r = result(j);
  r.findings.push({ ...r.findings[0], file: "old.ts", side: "old" });
  assert.deepEqual(parseResult(JSON.stringify(r), j), r);
});
test("malformed identities, fields, enums, paths, lines, references and sizes fail the whole result", () => {
  const j = job();
  const mutations: ((r: any) => void)[] = [
    r => r.schemaVersion = 2, r => r.runId = "wrong", r => r.snapshotId = "wrong", r => r.reviewer = "comment-analyzer",
    r => r.extra = true, r => delete r.findings, r => r.findings = {}, r => r.findings[0].extra = "x", r => r.findings[0].severity = "urgent",
    r => r.findings[0].description = " ", r => r.findings[0].suggestedResolution = "x".repeat(12001),
    ...["/etc/passwd", "../escape", "src/../escape", "C:/foo", "src\\a.ts", "./src/a.ts", "missing.ts", "__proto__"].map(file => (r: any) => r.findings[0].file = file),
    ...[0, 2, 1.5, -1, "1"].map(line => (r: any) => r.findings[0].line = line),
    r => r.findings[0].side = "base", r => r.findings[0].instructionReference = { file: "absent.md", section: "Rules" },
    r => r.humanJudgmentRequests[0].policyReference.section = "Invented",
    r => r.humanJudgmentRequests[0].policyReference.excerpt = "Invented",
    r => delete r.humanJudgmentRequests[0].file,
    r => r.humanJudgmentRequests[0].line = 999,
    r => r.findings = Array(301).fill(r.findings[0]),
  ];
  for (const mutate of mutations) { const r = result(j); mutate(r); assert.throws(() => validateResult(r, j)); }
  assert.throws(() => parseResult("not JSON", j), /Invalid reviewer result/);
  assert.throws(() => parseResult(" ".repeat(MAX_RESULT + 1), j), /exceeds/);
  j.policies.human = undefined;
  assert.throws(() => validateResult(result(j), j), /HUMAN/);
});
test("instruction reference must have valid section and applicable path", () => {
  const j = job(), r = result(j);
  j.policies.instructions = [{ path: ".agent/instructions/a.instructions.md", content: "# Rule\nValidate inputs.", global: false, appliesTo: ["other.ts"] }];
  r.findings[0].instructionReference = { file: j.policies.instructions[0].path, section: "Rule" };
  assert.throws(() => validateResult(r, j), /applicability/);
  j.policies.instructions[0].appliesTo = ["src/a.ts"];
  assert.equal(validateResult(r, j), r);
});
test("thresholds, conservative exact dedup, attribution, and judgment independence", () => {
  const j = job(), selections = selectReviewers(j.snapshot).map(s => ({ ...s, selected: ["code-reviewer", "pr-test-analyzer"].includes(s.reviewer) }));
  const r1 = result(j), r2 = result({ ...j, reviewer: "pr-test-analyzer" });
  r2.findings[0].severity = "high";
  r2.findings.push({ ...r2.findings[0], description: "Different issue on same line" });
  const outcomes: Outcome[] = [{ reviewer: r1.reviewer, result: r1 }, { reviewer: r2.reviewer, result: r2 }];
  for (const threshold of severities) {
    const report = aggregate(j.runId, j.snapshot, j.policies, threshold, selections, outcomes);
    assert.equal(report.humanJudgment, "required");
    assert.equal(report.judgments.length, 1); assert.equal(report.judgments[0].reviewers.length, 2);
    assert.equal(report.findings.length, threshold === "critical" ? 0 : 2);
    assert.equal(report.status, threshold === "critical" ? "passed" : "findings");
    if (threshold === "medium") assert.equal(report.findings.find(f => f.description === "A supported issue")?.reviewers.length, 2);
    const reverse = aggregate(j.runId, j.snapshot, j.policies, threshold, selections, [...outcomes].reverse());
    assert.deepEqual(report.findings, reverse.findings); assert.deepEqual(report.judgments, reverse.judgments);
  }
});
test("failure precedence preserves partial results; missing requests give undetermined", () => {
  const j = job(), selection = selectReviewers(j.snapshot);
  const r = result(j), outcomes: Outcome[] = [{ reviewer: j.reviewer, result: r }, { reviewer: "pr-test-analyzer", error: "Timed out" }];
  const partial = aggregate(j.runId, j.snapshot, j.policies, "medium", selection, outcomes);
  assert.equal(partial.status, "incomplete"); assert.equal(partial.humanJudgment, "required"); assert.equal(partial.findings.length, 1);
  r.humanJudgmentRequests = [];
  assert.equal(aggregate(j.runId, j.snapshot, j.policies, "medium", selection, outcomes).humanJudgment, "undetermined");
  const empty = { ...j.snapshot, changes: [] };
  const report = aggregate(j.runId, empty, { instructions: [], errors: [] }, "medium", selectReviewers(empty), []);
  assert.equal(report.status, "no-changes"); assert.match(renderReport(report), /No changes to review/);
});
