import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@earendil-works/pi-coding-agent";
import * as typebox from "typebox";
import { mkdtemp, mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorker } from "../src/worker.js";
import { job } from "./helpers.js";
import { mockModel } from "./mock-model.js";
import { reviewers } from "../src/types.js";

test("real Pi SDK denies attempted writes/shell/escape and never loads project capabilities", { timeout: 30000 }, async () => {
  const model = await mockModel(0, true), cwd = await mkdtemp(join(tmpdir(), "review-sdk-"));
  try {
    await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi/extensions/mutate.ts"), 'throw new Error("MUTATING_EXTENSION_LOADED");');
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_CONTEXT_MUST_NOT_LOAD");
    await writeFile(join(cwd, "settings.json"), JSON.stringify({ extensions: [".pi/extensions/mutate.ts"] }));
    const j = job(); j.snapshot.current["escape"] = { hash: "link", mode: "120000", limitation: "symlinks are not followed" };
    const result = await runWorker(j, sdk, typebox, cwd, model.directory);
    assert.equal(result.reviewer, "code-reviewer");
    assert.equal(model.errors.length, 0); assert.equal(model.requests.length, 5);
    await assert.rejects(access(join(cwd, "SHOULD_NOT_EXIST")));
    for (const request of model.requests) {
      const names = request.tools.map((t: any) => t.function.name);
      assert(!names.includes("bash")); assert(!names.includes("write")); assert(!names.includes("review")); assert(!names.includes("codemode"));
      const messages = JSON.stringify(request.messages);
      assert(!messages.includes("PROJECT_CONTEXT_MUST_NOT_LOAD")); assert(!messages.includes("MUTATING_EXTENSION_LOADED"));
      assert(!messages.includes("root:x:0:0"));
    }
    assert.match(JSON.stringify(model.requests.at(-1).messages), /not found|not available|Unknown tool|not exposed/i);
  } finally { await model.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
test("six fresh Pi SDK sessions overlap with no shared conversation history", { timeout: 30000 }, async () => {
  const model = await mockModel(400), cwd = await mkdtemp(join(tmpdir(), "review-sdk-parallel-"));
  try {
    const results = await Promise.all(reviewers.map(async reviewer => {
      const runtime = join(cwd, reviewer); await mkdir(runtime);
      return runWorker(job(reviewer), sdk, typebox, runtime, model.directory);
    }));
    assert.equal(results.length, 6); assert.equal(model.requests.length, 6); assert(model.peak() >= 2); assert.equal(model.identities.size, 1);
    for (const request of model.requests) assert.equal(request.messages.filter((m: any) => m.role === "user").length, 1);
  } finally { await model.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("invalid structured-output arguments cannot be repaired into a successful reviewer outcome", { timeout: 30000 }, async () => {
  const model = await mockModel(0, false, true), cwd = await mkdtemp(join(tmpdir(), "review-sdk-invalid-"));
  try {
    await assert.rejects(runWorker(job(), sdk, typebox, cwd, model.directory), /validation/);
  } finally { await model.dispose(); await rm(cwd, { recursive: true, force: true }); }
});
