import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { repo } from "./helpers.js";
import { capture, captureCommits } from "../src/snapshot.js";
import { readSnapshot, listSnapshot, searchSnapshot, MAX_SEARCH_HITS } from "../src/reader.js";
import { validateResult } from "../src/protocol.js";
import type { WorkerJob } from "../src/types.js";

// A base commit with more files than the old whole-repository capture allowed (20000), built with plumbing for speed.
async function largeRepo() {
  const r = await repo();
  const git = (args: string[], input?: string) => execFileSync("git", args, { cwd: r.root, input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  const blob = git(["hash-object", "-w", "--stdin"], "needle\n");
  const many = git(["mktree"], Array.from({ length: MAX_SEARCH_HITS + 1 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(5, "0")}.txt\n`).join(""));
  const tree = git(["mktree"], `${git(["ls-tree", "HEAD"])}\n040000 tree ${many}\tmany\n`);
  git(["update-ref", "refs/heads/main", git(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit-tree", tree, "-p", "HEAD", "-m", "many files"])]);
  git(["reset", "--hard", "-q", "main"]);
  await r.git("switch", "-c", "feature");
  await r.put("src/a.ts", "export const needle = 2;\n"); await r.git("commit", "-am", "feature");
  return r;
}
const jobFor = (snapshot: WorkerJob["snapshot"]): WorkerJob => ({ runId: "run", snapshot, reviewer: "code-reviewer", minimumSeverity: "medium", policies: { instructions: [], errors: [] }, provider: "fixture", model: "fixture" });
const finding = (file: string, line: number) => ({ schemaVersion: 1, runId: "run", snapshotId: "", reviewer: "code-reviewer", humanJudgmentRequests: [], findings: [{ severity: "medium", file, line, side: "new", description: "d", suggestedResolution: "r" }] });

test("a repository larger than 20000 files captures only changed files and serves the rest from git objects", { timeout: 120000 }, async () => {
  const r = await largeRepo();
  try {
    await r.put("src/a.ts", "export const needle = 3;\n");
    for (const snapshot of [await capture(r.root, "main"), await captureCommits(r.root, "main", "feature")]) {
      assert.deepEqual(snapshot.changes, [{ path: "src/a.ts", status: "modified", added: 1, removed: 1 }]);
      assert.deepEqual(Object.keys(snapshot.current), ["src/a.ts"]);
      assert.equal(Object.keys(snapshot.context!).length, MAX_SEARCH_HITS + 3);
      assert.equal(snapshot.context!["src/a.ts"], undefined);

      assert.equal((await readSnapshot(snapshot, "many/f00007.txt", "old")).text, "1: needle");
      assert.equal((await readSnapshot(snapshot, "README.md", "new")).text, "1: # Fixture");
      assert.equal(listSnapshot(snapshot, "new").total, MAX_SEARCH_HITS + 4);

      // Captured and context hits merge in path order; the bound is reported rather than silently applied.
      const search = await searchSnapshot(snapshot, "needle", "new");
      assert.equal(search.totalIsLowerBound, true); assert.equal(search.total, MAX_SEARCH_HITS);
      assert.equal(search.hits[0].path, "many/f00000.txt");
      const exact = await searchSnapshot(snapshot, "# Fixture", "new");
      assert.deepEqual(exact.hits, [{ path: "README.md", line: 1, excerpt: "# Fixture" }]); assert.equal(exact.totalIsLowerBound, undefined);
      assert.ok((await searchSnapshot(snapshot, "export const needle", "new")).hits.some(h => h.path === "src/a.ts"));

      // Reviewers may cite an unchanged caller, validated against its real contents.
      const job = jobFor(snapshot);
      validateResult({ ...finding("many/f00001.txt", 1), snapshotId: snapshot.id }, job);
      assert.throws(() => validateResult({ ...finding("many/f00001.txt", 2), snapshotId: snapshot.id }, job), /Invalid line/);
    }
  } finally { await r.dispose(); }
});
