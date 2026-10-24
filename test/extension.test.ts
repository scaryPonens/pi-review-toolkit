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
