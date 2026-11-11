import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as typebox from "typebox";
import { workerTools } from "../src/worker-tools.js";
import { job, result } from "./helpers.js";
import { readSnapshot, listSnapshot, searchSnapshot } from "../src/reader.js";

const invoke = async (tools: ReturnType<typeof workerTools>["tools"], name: string, params: unknown) => {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Denied: ${name} is not exposed`);
  return (tool.execute as (...args: any[]) => Promise<unknown>)("test-call", params, new AbortController().signal, undefined, {});
};
test("reviewer allowlist denies shell, writes, external reads, symlinks and recursion", async () => {
  const j = job(), boundary = workerTools(j, sdk, typebox);
  for (const name of ["bash", "write", "edit", "codemode", "review", "fetch", "lsp_navigation"]) await assert.rejects(invoke(boundary.tools, name, { path: "src/a.ts", text: "MUTATE" }), /Denied/);
  for (const path of ["/etc/passwd", "../outside", "src/../../outside", "file:///etc/passwd", "__proto__"]) await assert.rejects(invoke(boundary.tools, "read_snapshot", { path, side: "new" }));
  j.snapshot.current["escape"] = { hash: "link", mode: "120000", limitation: "symlinks are not followed" };
  await assert.rejects(invoke(boundary.tools, "read_snapshot", { path: "escape", side: "new" }), /Unsupported/);
  assert.equal(j.snapshot.current["src/a.ts"].text, "export const a = 2;\n");
});
test("reader pagination and literal search remain inside snapshot data", async () => {
  const j = job();
  j.snapshot.current["src/a.ts"].text = Array.from({ length: 250 }, (_, i) => `line ${i} [literal]`).join("\n");
  assert.equal((await readSnapshot(j.snapshot, "src/a.ts", "new", 1, 200)).nextLine, 201);
  assert.equal((await readSnapshot(j.snapshot, "src/a.ts", "new", 201, 200)).nextLine, null);
  const search = await searchSnapshot(j.snapshot, "[literal]", "new");
  assert.equal(search.total, 250); assert.equal(search.nextOffset, 100);
  assert.equal((await searchSnapshot(j.snapshot, "[literal]", "new", 200)).nextOffset, null);
  assert(listSnapshot(j.snapshot, "old").files.some(f => f.path === "old.ts"));
});
test("validated submission terminates; invalid output never becomes an approval", async () => {
  const j = job(), valid = workerTools(j, sdk, typebox);
  const submitted = await invoke(valid.tools, "submit_review", { json: JSON.stringify(result(j)) }) as { terminate: boolean };
  assert.equal(submitted.terminate, true); assert.equal(valid.completed().runId, j.runId);
  const repaired = workerTools(j, sdk, typebox);
  const rejected = await invoke(repaired.tools, "submit_review", { json: JSON.stringify({ ...result(j), extra: 1 }) }) as { terminate?: boolean; content: { text: string }[] };
  assert.equal(rejected.terminate, undefined); assert.match(rejected.content[0].text, /result: unknown fields \[\\"extra\\"\]/);
  assert.throws(() => repaired.completed(), /without/);
  await invoke(repaired.tools, "submit_review", { json: JSON.stringify(result(j)) });
  assert.equal(repaired.completed().runId, j.runId);
  await invoke(repaired.tools, "submit_review", { json: JSON.stringify(result(j)) });
  assert.throws(() => repaired.completed(), /Duplicate/);
  const invalid = workerTools(j, sdk, typebox);
  for (let i = 0; i < 3; i++) await invoke(invalid.tools, "submit_review", { json: "{" });
  await invoke(invalid.tools, "submit_review", { json: JSON.stringify(result(j)) });
  assert.throws(() => invalid.completed(), /Rejected after 3 invalid submissions/);
  const missing = workerTools(j, sdk, typebox); assert.throws(() => missing.completed(), /without/);
  const blocked = workerTools(j, sdk, typebox);
  await invoke(blocked.tools, "cannot_complete_review", { reason: "Required file is unsupported" });
  assert.throws(() => blocked.completed(), /unsupported/);
});
