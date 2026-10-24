import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { repo } from "./helpers.js";
import { runReview, type RunOptions } from "../dist/run.js";
import type { Backend } from "../src/backend.js";
import type { WorkerJob } from "../src/types.js";

function fixtureBackend(mode = "success") {
  const directories: string[] = [], snapshots = new Set<string>(), active = new Map<string, ReturnType<typeof setTimeout>>();
  let simultaneous = 0;
  const backend: Backend = {
    name: "fixture",
    async start(_command, cwd) {
      const id = `owned-${directories.length}`; directories.push(cwd);
      if (mode === "startup-failure" && cwd.endsWith("pr-test-analyzer")) throw new Error("Worker startup failed");
      const descriptor = JSON.parse(await readFile(join(cwd, "job.json"), "utf8"));
      const snapshot = JSON.parse(await readFile(descriptor.snapshotPath, "utf8"));
      snapshots.add(snapshot.id);
      const j: WorkerJob = { ...descriptor, snapshot };
      const timer = setTimeout(() => {
        const result = { schemaVersion: 1, runId: j.runId, snapshotId: snapshot.id, reviewer: j.reviewer, findings: [], humanJudgmentRequests: [] };
        if (mode === "invalid" && j.reviewer === "pr-test-analyzer") result.snapshotId = "wrong";
        if (mode !== "blocked") void writeFile(join(cwd, "result.json"), JSON.stringify({ ok: true, result }));
      }, mode === "blocked" ? 100000 : 300);
      active.set(id, timer); simultaneous = Math.max(simultaneous, active.size);
      return id;
    },
    async close(id) { const timer = active.get(id); if (timer) clearTimeout(timer); active.delete(id); },
    async cleanup() { for (const id of active.keys()) await backend.close(id); return []; },
  };
  return { backend, directories, snapshots, active, simultaneous: () => simultaneous };
}
const options = (root: string, backend: Backend): RunOptions => ({ cwd: root, base: "main", minimumSeverity: "medium", provider: "fixture", model: "fixture", sdkPath: fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)), agentDir: "/unused", backend, perReviewerMs: 10000, wholeRunMs: 20000 });
test("all selected workers overlap, share the snapshot, and leave no run artifacts", async () => {
  const r = await repo(), fixture = fixtureBackend();
  try {
    await r.put("src/a.ts", "changed\n");
    const index = await readFile(join(r.root, ".git/index"));
    const report = await runReview(options(r.root, fixture.backend));
    assert.equal(report.status, "passed"); assert.equal(report.outcomes.length, 6); assert.equal(fixture.snapshots.size, 1);
    assert.equal(fixture.simultaneous(), 6); assert.equal(fixture.active.size, 0);
    assert.deepEqual(await readFile(join(r.root, ".git/index")), index);
    for (const dir of fixture.directories) await assert.rejects(access(dir));
  } finally { await fixture.backend.cleanup(); await r.dispose(); }
});
test("empty changes bypass backend, while startup failure and invalid output are incomplete", async () => {
  const r = await repo();
  try {
    const empty = fixtureBackend(); assert.equal((await runReview(options(r.root, empty.backend))).status, "no-changes"); assert.equal(empty.directories.length, 0);
    await r.put("src/a.ts", "changed\n");
    for (const mode of ["startup-failure", "invalid"]) {
      const f = fixtureBackend(mode), report = await runReview(options(r.root, f.backend));
      assert.equal(report.status, "incomplete"); assert.equal(report.humanJudgment, "undetermined");
      assert(report.outcomes.some(o => o.error)); assert(report.outcomes.some(o => o.result)); assert.equal(f.active.size, 0);
    }
  } finally { await r.dispose(); }
});
test("blocked workers time out and explicit cancellation cleans up all owned resources", async () => {
  const r = await repo();
  try {
    await r.put("src/a.ts", "changed\n");
    const blocked = fixtureBackend("blocked");
    const timed = await runReview({ ...options(r.root, blocked.backend), perReviewerMs: 100 });
    assert.equal(timed.status, "incomplete"); assert(timed.outcomes.every(o => o.error?.includes("deadline"))); assert.equal(blocked.active.size, 0);
    const cancelled = fixtureBackend("blocked"), controller = new AbortController();
    const promise = runReview({ ...options(r.root, cancelled.backend), signal: controller.signal, onProgress: message => { if (message.includes("Reviewing snapshot")) setTimeout(() => controller.abort(), 30); } });
    const report = await promise; assert.equal(report.status, "incomplete"); assert.equal(cancelled.active.size, 0); assert.match(report.limitations.join("\n"), /cancelled/i);
  } finally { await r.dispose(); }
});
