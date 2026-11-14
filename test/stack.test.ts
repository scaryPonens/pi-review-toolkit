import test from "node:test";
import assert from "node:assert/strict";
import { repo } from "./helpers.js";
import { resolveStack } from "../src/stack.js";
import { parseStackArgs, renderStackReport, reviewStack } from "../src/stack-review.js";
import type { GhRunner } from "../src/pr.js";
import type { RunOptions } from "../src/run.js";
import type { Report } from "../src/types.js";

const oid = (n: number) => String(n).repeat(40).slice(0, 40);
const pr = (number: number, head: string, base: string, headOid = oid(number), baseOid = "0".repeat(40)) =>
  ({ number, url: `https://example.invalid/pull/${number}`, headRefName: head, headRefOid: headOid, baseRefName: base, baseRefOid: baseOid });
function fakeGh(open: ReturnType<typeof pr>[], all: Record<string, { number: number; state: string }[]> = {}): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (async (args: string[]) => {
    calls.push(args);
    if (args[0] === "repo") return JSON.stringify({ defaultBranchRef: { name: "main" } });
    if (args.includes("open")) return JSON.stringify(open);
    return JSON.stringify(all[args[args.indexOf("--head") + 1]] ?? []);
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

test("a stack is walked by branch, and through tool-managed bases by head commit", async () => {
  const gh = fakeGh([
    pr(1, "one", "main"),
    pr(2, "two", "one"),
    pr(3, "three", "graphite-base/3", oid(3), oid(2)), // base branch is no PR's head; it points at #2's head
    pr(4, "four", "three"),
    pr(5, "side", "two"), // another PR stacked on #2
    pr(9, "unrelated", "main"),
  ]);
  const stack = await resolveStack("/unused", 4, gh);
  assert.deepEqual(stack.pullRequests.map(p => [p.number, p.parent, p.link]), [[1, undefined, undefined], [2, 1, "branch"], [3, 2, "commit"], [4, 3, "branch"]]);
  assert.equal(stack.root, "main");
  assert.deepEqual(stack.notes, [
    "#2 also has #5 stacked on it, not reviewed here",
    "#3: base graphite-base/3 is not a pull request branch; it points at #2's head commit, so #2 is treated as its parent",
  ]);
  assert.equal(gh.calls.filter(c => c.includes("--head")).length, 0, "a stack on the default branch needs no closed-parent lookup");
});
test("stack shape problems are reported, and unresolvable stacks fail clearly", async () => {
  const closed = await resolveStack("/unused", 2, fakeGh([pr(2, "two", "old-parent")], { "old-parent": [{ number: 1, state: "MERGED" }] }));
  assert.deepEqual(closed.pullRequests.map(p => p.number), [2]);
  assert.match(closed.notes[0], /#2: its base old-parent is the head of merged pull request #1; retarget it before merging/);
  const orphan = await resolveStack("/unused", 2, fakeGh([pr(2, "two", "somewhere")]));
  assert.match(orphan.notes[0], /neither main nor an open pull request's branch/);
  const ambiguous = await resolveStack("/unused", 3, fakeGh([pr(1, "dup", "main"), pr(2, "dup", "main"), pr(3, "three", "dup")]));
  assert.deepEqual(ambiguous.pullRequests.map(p => p.number), [3]); assert.match(ambiguous.notes.join("\n"), /several open pull requests \(#1, #2\)/);
  await assert.rejects(resolveStack("/unused", 7, fakeGh([pr(1, "one", "main")])), /#7 is not open/);
  await assert.rejects(resolveStack("/unused", 2, fakeGh([pr(1, "one", "two"), pr(2, "two", "one")])), /loops back/);
  await assert.rejects(resolveStack("/unused", 1, async () => { throw new Error("gh: not logged in"); }), /Cannot read the default branch with gh: gh: not logged in/);
});
test("stack arguments take one pull request and an optional severity", () => {
  assert.deepEqual(parseStackArgs("#45294"), { pr: 45294, minimumSeverity: "medium", whole: false });
  assert.deepEqual(parseStackArgs("--min-severity high 12"), { pr: 12, minimumSeverity: "high", whole: false });
  assert.deepEqual(parseStackArgs("7 --whole"), { pr: 7, minimumSeverity: "medium", whole: true });
  for (const bad of ["", "1 2", "abc", "1 --min-severity", "1 --min-severity urgent", "1 --base main", "1 --whole --whole"]) assert.throws(() => parseStackArgs(bad), /Usage: \/review-stack/);
});

async function gitStack() {
  const r = await repo();
  await r.git("switch", "-c", "one"); await r.put("one.ts", "1\n"); await r.git("add", "."); await r.git("commit", "-m", "one");
  const one = await r.git("rev-parse", "HEAD");
  await r.git("switch", "-c", "two"); await r.put("two.ts", "2\n"); await r.git("add", "."); await r.git("commit", "-m", "two");
  const two = await r.git("rev-parse", "HEAD");
  return { ...r, one, two };
}
const report = (number: number, status: Report["status"], changed: string[] = [], findings: string[] = []): Report => ({ runId: `run-${number}`, snapshotId: "s", baseRef: "b", baseCommit: "c", minimumSeverity: "medium", status, humanJudgment: "not-identified", selection: [], outcomes: [], policies: { instructions: [], errors: [] }, judgments: [], limitations: [], changes: changed.map(path => ({ path, status: "modified" as const })), findings: findings.map(file => ({ severity: "medium" as const, file, line: 1, side: "new" as const, description: "d", suggestedResolution: "r", reviewers: ["code-reviewer" as const], instructionReferences: [] })) });
const options = (cwd: string, gh: GhRunner, signal?: AbortSignal) => ({ cwd, pr: 2, gh, signal, minimumSeverity: "medium" as const, provider: "p", model: "m", sdkPath: "/unused", agentDir: "/unused" });

test("a stack is reviewed bottom first, one pull request at a time, and every pull request is reported", async () => {
  const r = await gitStack();
  try {
    const gh = fakeGh([pr(1, "one", "main", r.one, r.base), pr(2, "two", "one", r.two, r.one)]);
    const order: number[] = [];
    let running = 0;
    const review = async (o: RunOptions) => {
      assert.equal(++running, 1, "reviews never overlap"); order.push(o.pr!);
      assert.equal(o.base, undefined);
      assert.equal(o.pullRequest?.headOid, o.pr === 1 ? r.one : r.two, "the stack passes each pull request it already resolved");
      assert.deepEqual(o.stack, o.pr === 1 ? { root: "main", below: [], above: [2] } : { parent: { number: 1, headRefName: "one" }, root: "main", below: [1], above: [] });
      await new Promise(resolve => setTimeout(resolve, 20)); running--;
      if (o.pr === 1) throw new Error("reviewer backend unavailable");
      return report(o.pr!, "findings");
    };
    const delivered: string[] = [];
    const stack = await reviewStack({ ...options(r.root, gh), onPullRequest: async (entry, i, total) => { delivered.push(`${i + 1}/${total} #${entry.number} ${entry.report?.status ?? entry.error}`); } }, review);
    assert.deepEqual(order, [1, 2]);
    assert.deepEqual(delivered, ["1/2 #1 reviewer backend unavailable", "2/2 #2 findings"], "each pull request is delivered as soon as its review ends");
    assert.equal(stack.status, "incomplete", "a pull request that could not be reviewed makes the stack incomplete");
    assert.equal(stack.reviews[0].error, "reviewer backend unavailable"); assert.equal(stack.reviews[1].report?.status, "findings");
    const text = renderStackReport(stack);
    assert.match(text, /Stack: main <- #1 <- #2/);
    assert.match(text, /#1 one: incomplete — reviewer backend unavailable/);
    assert.match(text, /## #2 two \(base one, parent #1\)/);
    assert.match(text, /Retry this pull request alone with \/review --pr 1/);
    assert.equal((await reviewStack(options(r.root, gh), async o => report(o.pr!, "passed"))).status, "passed");
  } finally { await r.dispose(); }
});
test("a stack review names one fetch for all missing commits, flags children behind their parent, and stops on cancel", async () => {
  const r = await gitStack();
  try {
    const missing = "f".repeat(40);
    await assert.rejects(reviewStack(options(r.root, fakeGh([pr(1, "one", "main", missing, r.base), pr(2, "two", "one", r.two, missing)])), async () => { throw new Error("must not review"); }),
      /no fetch is performed\)\. Run: git fetch origin refs\/pull\/1\/head one$/);

    // #1 moved on after #2 branched from it.
    await r.git("switch", "one"); await r.put("later.ts", "later\n"); await r.git("add", "."); await r.git("commit", "-m", "later");
    const moved = await r.git("rev-parse", "HEAD");
    const gh = fakeGh([pr(1, "one", "main", moved, r.base), pr(2, "two", "one", r.two, moved)]);
    const behind = await reviewStack(options(r.root, gh), async o => report(o.pr!, "passed"));
    assert.match(behind.notes.join("\n"), /#2 does not contain #1's latest head; rebase it onto #1/);
    assert.equal(behind.reviews[1].behind, 1);
    assert.match(renderStackReport(behind), /- #2 two: passed \(.*\) — behind #1, rebase first/);

    const controller = new AbortController();
    const cancelled = await reviewStack(options(r.root, gh, controller.signal), async o => { controller.abort(); return report(o.pr!, "incomplete"); });
    assert.deepEqual(cancelled.reviews.map(x => x.error ?? x.report?.status), ["incomplete", "Not started: the stack review was cancelled"]);
    assert.equal(cancelled.status, "incomplete");
  } finally { await r.dispose(); }
});
test("the whole-stack review compares the top against the root, and findings name later pull requests that touch their file", async () => {
  const r = await gitStack();
  try {
    const gh = fakeGh([pr(1, "one", "main", r.one, r.base), pr(2, "two", "one", r.two, r.one)]);
    const seen: { pr?: number; base?: string }[] = [];
    const stack = await reviewStack({ ...options(r.root, gh), whole: true }, async o => {
      seen.push({ pr: o.pr, base: o.base });
      if (o.base) return report(o.pr!, "passed", ["one.ts", "two.ts"]);
      return o.pr === 1 ? report(1, "findings", ["one.ts"], ["one.ts", "src/a.ts"]) : report(2, "findings", ["one.ts", "two.ts"], ["two.ts"]);
    });
    assert.deepEqual(seen, [{ pr: 1, base: undefined }, { pr: 2, base: undefined }, { pr: 2, base: "main" }]);
    assert.equal(stack.whole?.whole, true); assert.equal(stack.whole?.baseRefName, "main"); assert.equal(stack.whole?.report?.status, "passed");
    const [onePr] = stack.reviews;
    assert.deepEqual(onePr.report!.findings.map(f => [f.file, f.touchedAbove]), [["one.ts", [2]], ["src/a.ts", undefined]]);
    assert.equal(stack.reviews[1].report!.findings[0].touchedAbove, undefined, "nothing above the top");
    const text = renderStackReport(stack);
    assert.match(text, /- whole stack: #2 two against main: passed/);
    assert.match(text, /Touched above: one\.ts:1 is changed again by #2/);
    assert.match(text, /## Whole stack: #2 two against main/);
  } finally { await r.dispose(); }
});
