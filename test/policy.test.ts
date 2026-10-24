import test from "node:test";
import assert from "node:assert/strict";
import { snapshot, textEntry } from "./helpers.js";
import { loadPolicies, patterns } from "../src/policy.js";
import { aggregate, selectReviewers } from "../src/report.js";

test("recursive instruction matching includes old/new renamed and deleted paths", () => {
  const s = snapshot();
  s.changes = [{ path: "src/new.ts", oldPath: "legacy/old.ts", status: "renamed" }, { path: "legacy/deleted.ts", status: "deleted" }, { path: "src/.hidden.ts", status: "added" }];
  s.current[".agent/instructions/z/nested.instructions.md"] = textEntry('---\napplyTo: "legacy/**/*.ts,src/?.ts"\n---\n# Scoped\nRules.');
  s.current[".agent/instructions/a.instructions.md"] = textEntry('---\napplyTo: "src/**"\n---\n# Other\nRules.');
  s.current[".agent/reviewer-instructions.md"] = textEntry("Global");
  const p = loadPolicies(s);
  assert.equal(p.errors.length, 0);
  const legacy = p.instructions.find(i => i.path.includes("nested"))!;
  assert.deepEqual(legacy.appliesTo, ["legacy/deleted.ts", "legacy/old.ts", "src/new.ts"]);
  assert(p.instructions.find(i => i.path.includes("a.instructions"))!.appliesTo.includes("src/.hidden.ts"));
  assert.deepEqual(p.instructions.map(i => i.path), [...p.instructions.map(i => i.path)].sort());
});
test("bad front matter, duplicate keys, missing/empty applyTo and unsupported globs make review incomplete", () => {
  const invalid = ["No front matter", "---\napplyTo: ''\n---\n", "---\nfoo: bar\n---\n", "---\napplyTo: [src/**]\n---\n", "---\napplyTo: 'src/**'\napplyTo: 'other/**'\n---\n", "---\napplyTo: '[invalid'\n---\n"];
  for (const content of invalid) {
    const s = snapshot(); s.current[".agent/instructions/bad.instructions.md"] = textEntry(content);
    const policies = loadPolicies(s); assert.equal(policies.errors.length, 1);
    const report = aggregate("run", s, policies, "medium", selectReviewers(s), []);
    assert.equal(report.status, "incomplete"); assert.equal(report.humanJudgment, "undetermined");
  }
  for (const value of ["", "a,,b", "/abs/**", "../**", "src/!(a)", "[ab]", "a\\b", "a/{b,c}"]) assert.throws(() => patterns(value));
});
test("oversized or nontext policies are explicit failures rather than ignored/truncated", () => {
  const s = snapshot();
  s.current["HUMAN.md"] = textEntry("x".repeat(65537));
  s.current[".agent/instructions/bad.instructions.md"] = { hash: "bad", mode: "120000", limitation: "symlinks are not followed" };
  const p = loadPolicies(s); assert.equal(p.human, undefined); assert.equal(p.errors.length, 2);
  assert.match(p.errors.join("\n"), /64 KiB/);
});
