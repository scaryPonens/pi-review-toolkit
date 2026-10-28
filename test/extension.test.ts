import test from "node:test";
import assert from "node:assert/strict";
import * as sdk from "@earendil-works/pi-coding-agent";
import reviewExtension from "../src/extension.js";
import { repo } from "./helpers.js";
import { mockModel } from "./mock-model.js";
import { join } from "node:path";

async function sessionFor(root: string, agentDir: string, mode: "print" | "rpc" = "print") {
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [reviewExtension] });
  await loader.reload();
  const runtime = await sdk.ModelRuntime.create({ modelsPath: join(agentDir, "models.json"), authPath: join(agentDir, "auth.json") });
  const model = runtime.getModel("fixture", "fixture"); assert(model);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, model, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: sdk.SessionManager.inMemory(root), tools: ["review_report"] });
  await session.bindExtensions({ mode });
  return session;
}
test("actual Pi command delivers model-visible context without model continuation (including print mode)", { timeout: 20000 }, async () => {
  const r = await repo(), model = await mockModel(), session = await sessionFor(r.root, model.directory);
  try {
    await session.prompt("/review --base main");
    const report = session.messages.find((m: any) => m.role === "custom" && m.customType === "parallel-review");
    assert(report); assert.match(JSON.stringify(report), /No changes to review/);
    assert.equal(model.requests.length, 0); assert.equal(session.isStreaming, false);
    await session.prompt("/review --min-severity invalid");
    assert.match(JSON.stringify(session.messages.at(-1)), /Usage/); assert.equal(model.requests.length, 0);
  } finally { session.dispose(); await model.dispose(); await r.dispose(); }
});
test("overlap rejection and cancellation leave an explicit incomplete model-visible result", { timeout: 20000 }, async () => {
  const r = await repo(), model = await mockModel(), session = await sessionFor(r.root, model.directory, "rpc");
  try {
    await session.prompt("/review --base main");
    await session.prompt("/review --base main");
    assert.match(JSON.stringify(session.messages), /already active/);
    await session.prompt("/review-cancel");
    assert.match(JSON.stringify(session.messages), /incomplete/);
    assert.equal(model.requests.length, 0);
  } finally { session.dispose(); await model.dispose(); await r.dispose(); }
});

// Invoke the registered tool directly with real snapshot capture (no provider calls).
function toolHarness(root: string) {
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  reviewExtension({
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on() {}, sendMessage() {},
  } as unknown as sdk.ExtensionAPI);
  const ctx = { cwd: root, model: { provider: "fixture", id: "fixture" }, hasUI: false, mode: "print" };
  const invoke = (params = {}, signal?: AbortSignal) => tools.get("review_changes").execute("test", params, signal, undefined, ctx);
  return { tools, commands, ctx, invoke };
}

test("review_changes registers a structured tool, defaults to medium, and can run repeatedly", async () => {
  const r = await repo();
  try {
    await r.git("remote", "add", "origin", "https://example.invalid/fixture.git");
    await r.git("update-ref", "refs/remotes/origin/main", r.base);
    await r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const h = toolHarness(r.root);
    assert(h.tools.get("review_changes").outputSchema);
    for (const params of [{}, { min_severity: "high" }]) {
      const result = await h.invoke(params);
      assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
      assert.equal(result.structuredContent.status, "passed");
      assert.equal(result.structuredContent.noChanges, true);
      assert.equal(result.structuredContent.minimumSeverity, "min_severity" in params ? "high" : "medium");
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert(result.structuredContent.reviewers.every((r: any) => r.status === "skipped"));
    }
  } finally { await r.dispose(); }
});

test("review_changes fails closed on capture failure, invalid severity, missing model, cancellation and overlap", async () => {
  const r = await repo();
  try {
    const h = toolHarness(r.root);
    const missingBase = await h.invoke();
    assert.equal(missingBase.structuredContent.status, "incomplete");
    assert.equal(missingBase.isError, true); assert(missingBase.structuredContent.errors.length);
    const invalid = await h.invoke({ min_severity: "invalid" });
    assert.equal(invalid.isError, true); assert.match(invalid.structuredContent.errors[0], /Invalid severity/);
    const cancelled = await h.invoke({}, AbortSignal.abort());
    assert.equal(cancelled.isError, true); assert.equal(cancelled.structuredContent.status, "incomplete");
    await r.git("remote", "add", "origin", "https://example.invalid/fixture.git");
    await r.git("update-ref", "refs/remotes/origin/main", r.base);
    await r.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const running = h.invoke();
    const overlap = await h.invoke();
    assert.equal(overlap.isError, true); assert.match(overlap.structuredContent.errors[0], /already active/);
    await h.commands.get("review-cancel").handler();
    assert.equal((await running).structuredContent.status, "incomplete");
    h.ctx.model = undefined as any;
    const noModel = await h.invoke();
    assert.equal(noModel.isError, true); assert.match(noModel.structuredContent.errors[0], /Select a model/);
  } finally { await r.dispose(); }
});
