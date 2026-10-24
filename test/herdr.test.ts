import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repo } from "./helpers.js";
import { mockModel } from "./mock-model.js";
import { runReview } from "../dist/run.js";
import { command } from "../dist/backend.js";

test("real Herdr: six child Node/Pi processes, shared real diff, structured file transport, focus and cleanup", { skip: process.env.PI_REVIEW_TEST_HERDR !== "1", timeout: 90000 }, async () => {
  assert.equal(process.env.HERDR_ENV, "1");
  const r = await repo(), model = await mockModel(1500);
  const workspace = process.env.HERDR_WORKSPACE_ID!;
  const panes = async () => JSON.parse(await command("herdr", ["pane", "list", "--workspace", workspace])).result.panes.map((p: any) => p.pane_id).sort();
  const before = await panes();
  const focusedBefore = JSON.parse(await command("herdr", ["pane", "layout", "--current"])).result.layout.focused_pane_id;
  try {
    await r.git("checkout", "-b", "feature");
    await r.put("committed.ts", "committed\n"); await r.git("add", "."); await r.git("commit", "-m", "branch change");
    await r.put("src/a.ts", "staged\n"); await r.git("add", "src/a.ts"); await r.put("src/a.ts", "final unstaged\n");
    await r.put("untracked.ts", "untracked\n"); await r.put("HUMAN.md", "# Public behavior\nAsk before compatibility changes.\n");
    const index = await readFile(join(r.root, ".git/index"));
    const report = await runReview({ cwd: r.root, base: "main", minimumSeverity: "medium", provider: "fixture", model: "fixture", sdkPath: fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)), agentDir: model.directory, perReviewerMs: 60000, wholeRunMs: 75000 });
    assert.equal(report.status, "passed", JSON.stringify(report.outcomes));
    assert.equal(report.outcomes.length, 6); assert.equal(model.requests.length, 6); assert(model.peak() >= 2); assert.equal(model.identities.size, 1);
    assert.deepEqual(await readFile(join(r.root, ".git/index")), index);
    assert.deepEqual(await panes(), before);
    const focusedAfter = JSON.parse(await command("herdr", ["pane", "layout", "--current"])).result.layout.focused_pane_id;
    assert.equal(focusedAfter, focusedBefore);
    console.log(`Herdr smoke: ${report.outcomes.length}/6 completed; peak concurrent provider requests=${model.peak()}; snapshot=${report.snapshotId}; base=${report.baseCommit}`);
  } finally { await model.dispose(); await r.dispose(); }
});

test("real Herdr cancellation terminates only created workers and removes their artifacts", { skip: process.env.PI_REVIEW_TEST_HERDR !== "1", timeout: 90000 }, async () => {
  const r = await repo(), model = await mockModel(5000), controller = new AbortController();
  const { chooseBackend } = await import("../dist/backend.js");
  const backend = await chooseBackend();
  const directories: string[] = [];
  const wrapped = { name: backend.name, async start(shell: string, cwd: string, signal?: AbortSignal) { directories.push(cwd); return backend.start(shell, cwd, signal); }, close: (id: string) => backend.close(id), cleanup: () => backend.cleanup() };
  try {
    await r.put("src/a.ts", "changed\n");
    const pending = runReview({ cwd: r.root, base: "main", minimumSeverity: "medium", provider: "fixture", model: "fixture", sdkPath: fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)), agentDir: model.directory, backend: wrapped, signal: controller.signal, wholeRunMs: 60000 });
    const started = Date.now();
    while (model.requests.length < 6 && Date.now() - started < 20000) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(model.requests.length, 6);
    const pids = await Promise.all(directories.map(async cwd => Number(await readFile(join(cwd, "result.json.pid"), "utf8"))));
    controller.abort();
    const report = await pending;
    assert.equal(report.status, "incomplete"); assert.equal(report.humanJudgment, "undetermined");
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), (error: any) => error.code === "ESRCH");
  } finally { controller.abort(); await backend.cleanup(); await model.dispose(); await r.dispose(); }
});
