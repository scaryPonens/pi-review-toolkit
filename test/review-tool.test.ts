import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Backend } from "../src/backend.js";
import type { Result } from "../src/types.js";
import { repo } from "./helpers.js";
import { runReview as realRunReview } from "../dist/run.js";

// Replace only backend selection/deadlines: execute real capture, worker artifact
// validation, filtering and aggregation through the registered compiled tool.
let mode = "success";
const backend: Backend = {
  name: "fixture",
  async start(_command, cwd) {
    const job = JSON.parse(await readFile(join(cwd, "job.json"), "utf8"));
    const snapshot = JSON.parse(await readFile(job.snapshotPath, "utf8"));
    const result: Result = {
      schemaVersion: 1, runId: job.runId, snapshotId: snapshot.id, reviewer: job.reviewer,
      findings: ["low", "medium", "high", "critical"].map(severity => ({ severity: severity as any, file: "src/a.ts", line: 1, side: "new", description: `${severity} issue`, suggestedResolution: `Resolve ${severity} issue` })),
      humanJudgmentRequests: [],
    };
    if (mode === "invalid") result.snapshotId = "wrong";
    if (mode === "failure") throw new Error("fixture startup failure");
    if (mode !== "timeout") await writeFile(join(cwd, "result.json"), JSON.stringify({ ok: true, result }));
    return cwd;
  },
  async close() {}, async cleanup() { return []; },
};
mock.module("../dist/run.js", { namedExports: {
  runReview: (options: Parameters<typeof realRunReview>[0]) => realRunReview({ ...options, backend, perReviewerMs: mode === "timeout" ? 30 : 10000 }),
} });
const { default: reviewExtension } = await import("../dist/extension.js");

test("registered review_changes returns actionable filtered findings and fails closed on worker failures", { timeout: 30000 }, async () => {
  const r = await repo();
  try {
    await r.git("remote", "add", "origin", "https://example.invalid/fixture.git");
    await r.git("update-ref", "refs/remotes/origin/main", r.base);
    await r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    await r.put("src/a.ts", "export const a = 2;\n");
    let tool: any;
    reviewExtension({ registerTool(t: any) { if (t.name === "review_changes") tool = t; }, registerCommand() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
    const invoke = (params = {}) => tool.execute("test", params, undefined, undefined, { cwd: r.root, model: { provider: "fixture", id: "fixture" }, hasUI: false });
    for (const [params, expected] of [[{}, ["critical", "high", "medium"]], [{ min_severity: "high" }, ["critical", "high"]], [{ min_severity: "low" }, ["critical", "high", "medium", "low"]]] as const) {
      const result = await invoke(params), data = result.structuredContent;
      assert.equal(result.isError, false, JSON.stringify(data)); assert.equal(data.status, "findings");
      assert.deepEqual(data.findings.map((f: any) => f.severity), expected);
      assert.equal(data.reviewers.length, 6); assert(data.reviewers.every((r: any) => r.status === "completed"));
      for (const finding of data.findings) {
        assert.equal(finding.file, "src/a.ts"); assert.equal(finding.line, 1);
        assert(finding.description); assert(finding.suggestedResolution); assert.equal(finding.reviewers.length, 6);
      }
      assert.deepEqual(JSON.parse(result.content[0].text), data);
    }
    for (mode of ["invalid", "failure", "timeout"]) {
      const result = await invoke();
      assert.equal(result.isError, true); assert.equal(result.structuredContent.status, "incomplete");
      assert(result.structuredContent.reviewers.every((r: any) => r.status === "failed" && r.error));
    }
    mode = "success";
    await r.put("src/a.ts", "export const a = 1;\n");
    const fixed = await invoke();
    assert.equal(fixed.structuredContent.status, "passed"); assert.equal(fixed.structuredContent.noChanges, true);
  } finally { await r.dispose(); }
});
