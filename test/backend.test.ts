import test from "node:test";
import assert from "node:assert/strict";
import { HerdrBackend, OrcaBackend, TmuxBackend, chooseBackend, orcaCli, quote, type CommandRunner } from "../src/backend.js";

test("Herdr parses creation IDs, preserves focus and cleans only owned panes idempotently", async () => {
  const calls: string[][] = [];
  let next = 0;
  const run: CommandRunner = async (binary, args) => {
    calls.push([binary, ...args]);
    if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 160, height: 40 } }, { pane_id: "w1:p999", rect: { width: 900, height: 900 } }] } } });
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: ["opaque-A", "opaque-B"][next++] } } });
    return "";
  };
  const b = new HerdrBackend("w1:p1", run);
  const ids = await Promise.all([b.start("trusted command 1", "/tmp"), b.start("trusted command 2", "/tmp")]);
  assert.deepEqual(ids, ["opaque-A", "opaque-B"]);
  await b.close("w1:p999"); await b.cleanup(); await b.cleanup();
  const splits = calls.filter(c => c[2] === "split");
  assert(splits.every(c => c.includes("--no-focus") && c.includes("w1:p1")));
  assert.deepEqual(calls.filter(c => c[2] === "close").map(c => c[3]).sort(), ids);
});
test("cancelled queued Herdr startup creates no new panes", async () => {
  const controller = new AbortController(); controller.abort();
  const b = new HerdrBackend("w1:p1", async () => { throw new Error("Must not call backend"); });
  await assert.rejects(b.start("command", "/tmp", controller.signal), /abort/i);
  assert.deepEqual(await b.cleanup(), []);
});
test("tmux parses actual IDs and creates detached owned sessions only", async () => {
  const calls: string[][] = [];
  const b = new TmuxBackend(async (_binary, args) => { calls.push(args); return args[0] === "new-session" ? "%123\n" : ""; });
  assert.equal(await b.start("echo safe", "/tmp"), "%123");
  await b.close("%999"); await b.cleanup();
  assert(calls[0].includes("-d")); assert(calls[0].includes("#{pane_id}"));
  assert.deepEqual(calls[1], ["kill-pane", "-t", "%123"]);
});
test("backend selection fails closed, with no fallback after choosing Herdr", async () => {
  const calls: string[] = [];
  const run: CommandRunner = async binary => { calls.push(binary); if (binary === "herdr") throw new Error("Herdr down"); return "tmux 3.5a"; };
  await assert.rejects(chooseBackend(run, { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), /Herdr down/);
  assert.deepEqual(calls, ["herdr"]);
  assert.equal((await chooseBackend(run, {})).name, "tmux");
  await assert.rejects(chooseBackend(async () => { throw new Error("missing"); }, {}), /No supported execution backend/);
  assert.equal(quote("a'b;$(echo bad)"), "'a'\"'\"'b;$(echo bad)'");
});
test("cleanup failures remain explicit and retryable", async () => {
  let fail = true;
  const b = new HerdrBackend("w1:p1", async (_binary, args) => {
    if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 100, height: 30 } }] } } });
    if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "w1:p22" } } });
    if (args[1] === "close" && fail) throw new Error("Cannot close");
    if (args[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w1:p22" }] } });
    return "";
  });
  await b.start("command", "/tmp");
  assert.equal((await b.cleanup()).length, 1);
  fail = false; assert.deepEqual(await b.cleanup(), []);
});
test("Orca runs reviewers in one unfocused tab, splitting its largest pane, and cleans only owned panes", async () => {
  const calls: string[][] = [];
  let next = 0, closeFails = false;
  const run: CommandRunner = async (binary, args) => {
    calls.push([binary, ...args]);
    const handle = `term_${++next}`;
    if (args[1] === "create") return JSON.stringify({ ok: true, result: { terminal: { handle } } });
    if (args[1] === "split") return JSON.stringify({ ok: true, result: { split: { handle } } });
    if (args[1] === "close" && closeFails) return JSON.stringify({ ok: false, error: { code: "terminal_not_found", message: "gone" } });
    if (args[1] === "show") return JSON.stringify({ ok: true, result: { terminal: { handle: args[3], connected: false } } });
    return JSON.stringify({ ok: true, result: {} });
  };
  const b = new OrcaBackend("orca", run);
  const ids = await Promise.all(Array.from({ length: 4 }, (_, i) => b.start(`echo ${i}`, "/tmp/reviewer dir")));
  assert.deepEqual(ids, ["term_1", "term_2", "term_3", "term_4"]);
  const creates = calls.filter(c => c[2] === "create"), splits = calls.filter(c => c[2] === "split");
  assert.equal(creates.length, 1); assert(!creates[0].includes("--focus")); assert(creates.every(c => c.at(-1) === "--json"));
  // 2x1 tab: split left/right, then each half top/bottom.
  assert.deepEqual(splits.map(c => [c[4], c[6]]), [["term_1", "vertical"], ["term_1", "horizontal"], ["term_2", "horizontal"]]);
  assert.equal(creates[0][creates[0].indexOf("--command") + 1], `/bin/sh -c ${quote(`cd ${quote("/tmp/reviewer dir")} || exit 1; echo 0`)}`);
  await b.close("term_999"); assert(!calls.some(c => c[2] === "close" && c[4] === "term_999"));
  closeFails = true;
  assert.deepEqual(await b.cleanup(), []);
  assert.deepEqual(calls.filter(c => c[2] === "close").map(c => c[4]).sort(), ids);
});
test("an Orca session selects Orca, and a failing Orca CLI is an error rather than a tmux fallback", async () => {
  const ok: CommandRunner = async () => JSON.stringify({ ok: true, result: { terminal: { handle: "term_me" } } });
  assert.equal((await chooseBackend(ok, { ORCA_TERMINAL_HANDLE: "term_me" })).name, "orca");
  const calls: string[] = [];
  const down: CommandRunner = async binary => { calls.push(binary); return JSON.stringify({ ok: false, error: { code: "runtime_unavailable", message: "Orca is not running" } }); };
  await assert.rejects(chooseBackend(down, { ORCA_TERMINAL_HANDLE: "term_me", ORCA_CLI_COMMAND: "orca-wsl" }), /runtime_unavailable: Orca is not running/);
  assert.deepEqual(calls, ["orca-wsl"]);
  assert.equal(orcaCli({}), "orca"); assert.equal(orcaCli({ ORCA_DEV_REPO_ROOT: "/x" }), "orca-dev");
  // Herdr keeps precedence when both are present.
  assert.equal((await chooseBackend(async () => "herdr 0.8.1", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", ORCA_TERMINAL_HANDLE: "term_me" })).name, "herdr");
});
