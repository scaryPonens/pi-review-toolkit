import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { repo } from "./helpers.js";
import { capture, rootOf, selectBase } from "../src/snapshot.js";
import { loadPolicies } from "../src/policy.js";
import { readSnapshot } from "../src/reader.js";

test("real Git snapshot includes committed, staged, unstaged, untracked final content without touching index", async () => {
  const r = await repo();
  try {
    await r.git("checkout", "-b", "feature");
    await r.put("committed.ts", "committed\n"); await r.git("add", "."); await r.git("commit", "-m", "feature");
    await r.put("src/a.ts", "staged\n"); await r.git("add", "src/a.ts");
    await r.put("src/a.ts", "final unstaged\n"); await r.put("untracked.ts", "new\n"); await r.put("ignored.tmp", "never include\n");
    const index = await readFile(join(r.root, ".git/index"));
    const s = await capture(r.root, "main");
    assert.equal(s.baseCommit, r.base); assert.equal(s.current["src/a.ts"].text, "final unstaged\n");
    assert(s.changes.some(c => c.path === "committed.ts")); assert(s.changes.some(c => c.path === "untracked.ts"));
    assert(!s.current["ignored.tmp"]); assert(s.diff.includes("final unstaged"));
    assert.deepEqual(await readFile(join(r.root, ".git/index")), index);
    await r.put("src/a.ts", "later edit\n"); assert.equal((await readSnapshot(s, "src/a.ts", "new")).text, "1: final unstaged");
    const s2 = await capture(r.root, "main"); assert.notEqual(s.id, s2.id);
    assert.equal(await rootOf(join(r.root, "src")), r.root);
  } finally { await r.dispose(); }
});
test("empty diff, exact rename, deletion and unsupported changed content are explicit", async () => {
  const r = await repo();
  try {
    assert.equal((await capture(r.root, "main")).changes.length, 0);
    await rename(join(r.root, "src/a.ts"), join(r.root, "src/b.ts"));
    await rm(join(r.root, "README.md"));
    await r.put("binary.dat", Buffer.from([0, 1, 2]));
    await r.put("large.dat", "x".repeat(1024 * 1024 + 1));
    await symlink("/etc/passwd", join(r.root, "escape"));
    await r.put("pointer", "version https://git-lfs.github.com/spec/v1\noid sha256:test\nsize 50\n");
    const s = await capture(r.root, "main");
    assert(s.changes.some(c => c.status === "renamed" && c.oldPath === "src/a.ts" && c.path === "src/b.ts"));
    assert(s.changes.some(c => c.status === "deleted" && c.path === "README.md"));
    for (const path of ["binary.dat", "large.dat", "escape", "pointer"]) assert(s.limitations.some(x => x.startsWith(path)));
    await assert.rejects(readSnapshot(s, "escape", "new"), /Unsupported/);
    for (const path of ["../escape", "/etc/passwd", "src/../../escape"]) await assert.rejects(readSnapshot(s, path, "new"), /relative/);
  } finally { await r.dispose(); }
});
test("unchanged oversized content is not a false-positive change", async () => {
  const r = await repo();
  try {
    await r.put("large.dat", "x".repeat(1024 * 1024 + 1)); await r.git("add", "."); await r.git("commit", "-m", "large");
    assert.equal((await capture(r.root, "HEAD")).changes.length, 0);
  } finally { await r.dispose(); }
});
test("explicit/inferred refs and missing/ambiguous target fail clearly", async () => {
  const r = await repo();
  try {
    assert.equal(await selectBase(r.root, "main"), "main");
    await assert.rejects(selectBase(r.root), /--base/);
    await assert.rejects(selectBase(r.root, "missing-ref")); await assert.rejects(selectBase(r.root, "--help"));
    await r.git("remote", "add", "origin", "https://example.invalid/repo");
    await r.git("update-ref", "refs/remotes/origin/main", r.base);
    await r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    assert.equal(await selectBase(r.root), "refs/remotes/origin/main");
    await r.git("remote", "add", "other", "https://example.invalid/other");
    await r.git("update-ref", "refs/remotes/other/dev", r.base);
    await r.git("symbolic-ref", "refs/remotes/other/HEAD", "refs/remotes/other/dev");
    await assert.rejects(selectBase(r.root), /unambiguous/);
  } finally { await r.dispose(); }
});
test("merge conflicts fail before launching any reviewers", async () => {
  const r = await repo();
  try {
    await r.git("checkout", "-b", "other"); await r.put("src/a.ts", "other\n"); await r.git("commit", "-am", "other");
    await r.git("checkout", "main"); await r.put("src/a.ts", "main\n"); await r.git("commit", "-am", "main");
    await r.git("merge", "other").catch(() => {});
    await assert.rejects(capture(r.root, "HEAD"), /Unresolved merge conflicts/);
  } finally { await r.dispose(); }
});
test("capture retries or fails when the working tree changes continuously", async () => {
  const r = await repo(); let interval: ReturnType<typeof setInterval> | undefined;
  try {
    let i = 0;
    interval = setInterval(() => { void r.put("src/a.ts", `${++i}\n`); }, 2);
    await assert.rejects(capture(r.root, "main"), /during capture/);
  } finally { if (interval) clearInterval(interval); await new Promise(resolve => setTimeout(resolve, 25)); await r.dispose(); }
});
test("policy capture is snapshot-only and malformed or escaped instructions are not omitted", async () => {
  const r = await repo();
  try {
    await r.put("HUMAN.md", "# Security\nAsk for approval.\n");
    await r.put(".agent/reviewer-instructions.md", "# Rules\nValidate data.\n");
    await r.put(".agent/instructions/nested/api.instructions.md", '---\napplyTo: "src/**/*.ts"\n---\n# API rules\nReject bad input.\n');
    await r.put(".agent/instructions/none.instructions.md", '---\napplyTo: "other/**"\n---\nOther.\n');
    const s = await capture(r.root, "main"), p = loadPolicies(s);
    assert.equal(p.errors.length, 0); assert.equal(p.human?.content, "# Security\nAsk for approval.\n");
    await r.put("HUMAN.md", "Changed after capture"); assert.equal(p.human?.content, "# Security\nAsk for approval.\n");
    assert(p.instructions.find(i => i.path.includes("nested"))?.appliesTo.includes("src/a.ts") === false); // unchanged file is not in manifest
    await r.put("src/a.ts", "changed\n");
    const p2 = loadPolicies(await capture(r.root, "main"));
    assert(p2.instructions.find(i => i.path.includes("nested"))?.appliesTo.includes("src/a.ts"));
    await r.put(".agent/instructions/bad.instructions.md", "missing front matter");
    await symlink("/etc/passwd", join(r.root, ".agent/instructions/escape.instructions.md"));
    const failed = loadPolicies(await capture(r.root, "main"));
    assert.equal(failed.errors.length, 2);
  } finally { await r.dispose(); }
});

test("ignored untracked policies are captured as guidance, not added to the review scope", async () => {
  const r = await repo();
  try {
    await r.put(".gitignore", "ignored*\n.agent/\nHUMAN.md\n"); await r.git("commit", "-am", "ignore guidance");
    await r.put("HUMAN.md", "# Approval\nAsk before changes.\n");
    await r.put(".agent/reviewer-instructions.md", "# Rules\nValidate inputs.\n");
    const s = await capture(r.root, "HEAD"), p = loadPolicies(s);
    assert.equal(s.changes.length, 0); assert.equal(p.instructions.length, 1); assert(p.human);
  } finally { await r.dispose(); }
});

test("submodules are opaque: unchanged pointers are not false changes; dirty content is incomplete coverage", async () => {
  const r = await repo(), sub = await repo();
  try {
    await r.git("-c", "protocol.file.allow=always", "submodule", "add", sub.root, "vendor");
    await r.git("commit", "-am", "submodule");
    assert.equal((await capture(r.root, "HEAD")).changes.length, 0);
    await r.put("vendor/src/a.ts", "changed in submodule\n");
    const s = await capture(r.root, "HEAD");
    assert(s.changes.some(c => c.path === "vendor")); assert(s.limitations.some(l => l.includes("submodule")));
    assert.equal(s.current["vendor"].text, undefined);
  } finally { await r.dispose(); await sub.dispose(); }
});
test("generated and large data files are collapsed in the diff but stay readable; the diff opens with a file map", async () => {
  const { collapseReason, diffAttributes, DATA_COLLAPSE_LINES } = await import("../src/snapshot.js");
  const r = await repo();
  try {
    await r.put(".gitattributes", "**/openapi.json linguist-generated=true\nvendor/* linguist-generated\ncatalogue/*.json linguist-generated=false\nnotes/*.md review-collapse\n");
    await r.git("add", "."); await r.git("commit", "-q", "-m", "attributes");
    await r.put("src/a.ts", "export const a = 2;\n");
    await r.put("uv.lock", "locked\n");
    await r.put("api/openapi.json", "{\"generated\": true}\n");
    await r.put("fixtures/big.json", Array.from({ length: DATA_COLLAPSE_LINES + 1 }, (_, i) => `"${i}"`).join(",\n") + "\n");
    await r.put("config/small.json", "{\"a\": 1}\n");
    await r.put("catalogue/lines.json", Array.from({ length: DATA_COLLAPSE_LINES + 1 }, (_, i) => `"${i}"`).join(",\n") + "\n");
    await r.put("notes/long.md", "# Notes\n");
    const s = await capture(r.root, "main");
    const by = Object.fromEntries(s.changes.map(c => [c.path, c]));
    assert.equal(by["uv.lock"].collapsed, "lockfile");
    assert.equal(by["api/openapi.json"].collapsed, "generated per .gitattributes");
    assert.match(by["fixtures/big.json"].collapsed!, /^data file, \d+ changed lines$/);
    assert.equal(by["config/small.json"].collapsed, undefined, "small data files stay in the diff");
    assert.equal(by["src/a.ts"].collapsed, undefined);
    assert.equal(by["catalogue/lines.json"].collapsed, undefined, "linguist-generated=false keeps a large data file in the diff");
    assert.equal(by["notes/long.md"].collapsed, "review-collapse per .gitattributes");
    assert.ok(s.diff.includes('+"0",'), "the opted-out data file\'s hunks are in the diff");
    assert.ok(!s.diff.includes("+# Notes"), "the opted-in file\'s hunks are not");
    assert.deepEqual([by["src/a.ts"].added, by["src/a.ts"].removed], [1, 1]);
    assert.match(s.diff, /^Files: 7 changed, \+\d+ -\d+ lines, 4 collapsed/);
    assert.match(s.diff, /  modified src\/a\.ts  \+1 -1\n/);
    assert.match(s.diff, /  added    uv\.lock  \+1 -0  \[collapsed: lockfile\]/);
    assert.ok(!s.diff.includes("+locked"), "collapsed hunks are omitted");
    assert.ok(s.diff.includes("+export const a = 2;"), "other hunks remain");
    assert.ok(s.diff.includes('"config/small.json"; mode absent -> 100644; +1 -0\n'));
    assert.equal((await readSnapshot(s, "uv.lock", "new")).text, "1: locked", "collapsed files are still readable");
    const attrs = diffAttributes("# comment\n*.min.js linguist-generated=true\ndocs/** linguist-vendored\n/build/out.js linguist-generated\nbuild/keep.js -linguist-generated\nfixtures/** review-collapse=true\nfixtures/golden.json review-collapse=false\nodd.txt !linguist-generated\n");
    assert.deepEqual(attrs("a/b/x.min.js"), { generated: true }); assert.deepEqual(attrs("build/out.js"), { generated: true });
    assert.deepEqual(attrs("build/keep.js"), { generated: false }, "-name unsets");
    assert.deepEqual(attrs("docs/x.md"), {}); assert.deepEqual(attrs("src/x.js"), {}); assert.deepEqual(attrs("odd.txt"), {}, "!name is unspecified");
    assert.deepEqual(attrs("fixtures/a/b.json"), { collapse: true }); assert.deepEqual(attrs("fixtures/golden.json"), { collapse: false }, "later lines win");
    const none = () => ({});
    assert.equal(collapseReason("x.map", 1, none), "minified or source map");
    assert.equal(collapseReason("data.csv", DATA_COLLAPSE_LINES, none), undefined);
    assert.equal(collapseReason("data.csv", DATA_COLLAPSE_LINES + 1, none), `data file, ${DATA_COLLAPSE_LINES + 1} changed lines`);
    assert.equal(collapseReason("uv.lock", 1, () => ({ collapse: false })), undefined, "review-collapse=false keeps even a lockfile");
    assert.equal(collapseReason("uv.lock", 1, () => ({ generated: false })), undefined, "linguist-generated=false keeps a lockfile too");
    assert.equal(collapseReason("src/x.ts", 3, () => ({ collapse: true })), "review-collapse per .gitattributes");
    assert.equal(collapseReason("src/x.ts", 3, () => ({ collapse: false, generated: true })), undefined, "review-collapse wins over linguist-generated");
  } finally { await r.dispose(); }
});
