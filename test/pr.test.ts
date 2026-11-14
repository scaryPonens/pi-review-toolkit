import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./helpers.js";
import { resolvePullRequest, type GhRunner } from "../src/pr.js";
import { captureCommits } from "../src/snapshot.js";
import { readSnapshot } from "../src/reader.js";

// main <- parent (README) <- child (src/a.ts): a two-PR stack.
async function stack() {
  const r = await repo();
  await r.git("switch", "-c", "parent");
  await r.put("README.md", "# Parent\n"); await r.git("commit", "-am", "parent");
  const parent = await r.git("rev-parse", "HEAD");
  await r.git("switch", "-c", "child");
  await r.put("src/a.ts", "export const a = 2;\n"); await r.git("commit", "-am", "child");
  const child = await r.git("rev-parse", "HEAD");
  await r.git("switch", "main");
  return { ...r, parent, child };
}
const view = (fields: Record<string, unknown>): GhRunner => async () => JSON.stringify({ number: 7, state: "OPEN", url: "https://example.invalid/pull/7", baseRefName: "parent", headRefName: "child", ...fields });

test("a stacked pull request resolves to its own base and head commits", async () => {
  const r = await stack();
  try {
    const calls: string[][] = [];
    const pr = await resolvePullRequest(r.root, 7, async (args, cwd) => { calls.push(args); assert.equal(cwd, r.root); return view({ baseRefOid: r.parent, headRefOid: r.child })(args, cwd); });
    assert.deepEqual(pr, { number: 7, state: "OPEN", url: "https://example.invalid/pull/7", baseRefName: "parent", headRefName: "child", baseOid: r.parent, headOid: r.child });
    assert.deepEqual(calls[0].slice(0, 3), ["pr", "view", "7"]);
  } finally { await r.dispose(); }
});
test("pull request resolution never fetches and names the commits to fetch", async () => {
  const r = await stack();
  try {
    const missing = "f".repeat(40);
    await assert.rejects(resolvePullRequest(r.root, 7, view({ baseRefOid: r.parent, headRefOid: missing })), /no fetch is performed\)\. Run: git fetch origin refs\/pull\/7\/head$/);
    await assert.rejects(resolvePullRequest(r.root, 7, view({ baseRefOid: missing, headRefOid: missing })), /git fetch origin parent refs\/pull\/7\/head$/);
    await assert.rejects(resolvePullRequest(r.root, 7, view({ number: 8, baseRefOid: r.parent, headRefOid: r.child })), /unexpected description/);
    await assert.rejects(resolvePullRequest(r.root, 7, view({ baseRefOid: "parent", headRefOid: r.child })), /unexpected description/);
    await assert.rejects(resolvePullRequest(r.root, 7, async () => { throw new Error("gh: not logged in"); }), /Cannot resolve pull request #7 with gh: gh: not logged in/);
    await assert.rejects(resolvePullRequest(r.root, 0, view({})), /Invalid pull request number/);
  } finally { await r.dispose(); }
});
test("commit capture covers only the child's changes and ignores the working tree", async () => {
  const r = await stack();
  try {
    await r.put("src/a.ts", "dirty working tree\n");
    const index = await readFile(join(r.root, ".git/index"));
    const snapshot = await captureCommits(r.root, r.parent, r.child);
    assert.equal(snapshot.baseCommit, r.parent); assert.equal(snapshot.head, r.child);
    assert.deepEqual(snapshot.changes, [{ path: "src/a.ts", status: "modified", added: 1, removed: 1 }]);
    assert.equal(snapshot.current["src/a.ts"].text, "export const a = 2;\n");
    assert.equal(snapshot.current["README.md"], undefined, "unchanged files are context, not captured");
    assert.equal((await readSnapshot(snapshot, "README.md", "new")).text, "1: # Parent");
    assert.deepEqual(await readFile(join(r.root, ".git/index")), index);
    // A parent that moved after the child branched still yields only the child's changes.
    await r.git("switch", "parent"); await r.put("src/b.ts", "later\n"); await r.git("add", "src/b.ts"); await r.git("commit", "-m", "parent moved");
    const moved = await captureCommits(r.root, "parent", r.child);
    assert.equal(moved.baseCommit, r.parent); assert.deepEqual(moved.changes.map(c => c.path), ["src/a.ts"]);
  } finally { await r.dispose(); }
});
test("reviewers are told where a pull request sits in its stack", async () => {
  const { stackNote } = await import("../src/worker.js");
  const { job } = await import("./helpers.js");
  const pullRequest = { number: 2, state: "OPEN", url: "u", baseRefName: "one", headRefName: "two", baseOid: "a".repeat(40), headOid: "b".repeat(40) };
  assert.equal(stackNote(job()), "", "no stack, no note");
  const middle = stackNote({ ...job(), pullRequest, stack: { parent: { number: 1, headRefName: "one" }, root: "main", below: [1], above: [3] } });
  assert.match(middle, /#2 \(two\) is stacked on #1 \(one\)/);
  assert.match(middle, /#1 are stacked below it and merge first; their code is pre-existing for this review/);
  assert.match(middle, /#3 are stacked above it and are reviewed separately/);
  const bottom = stackNote({ ...job(), pullRequest, stack: { root: "main", below: [], above: [3] } });
  assert.match(bottom, /is based on main\. It is the bottom of its stack, on main\./);
});
