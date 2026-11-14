import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@earendil-works/pi-coding-agent";
import { providerExtensions } from "../src/extension.js";
import { registerProviders } from "../src/worker.js";

const providerSource = `export default function (pi) {
  pi.registerProvider("fixture-proxy", {
    name: "Fixture proxy", baseUrl: "https://proxy.example.invalid", apiKey: "fixture-key", api: "anthropic-messages",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
  });
}
`;

test("provider extensions come only from global settings, resolved to absolute paths", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "review-agent-"));
  try {
    assert.deepEqual(await providerExtensions(agentDir), []);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "x" }));
    assert.deepEqual(await providerExtensions(agentDir), []);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ parallelReview: { providerExtensions: ["~/.pi/extensions/p.ts", "extensions/q.ts", "/abs/r.ts"] } }));
    assert.deepEqual(await providerExtensions(agentDir), [join(homedir(), ".pi/extensions/p.ts"), join(agentDir, "extensions/q.ts"), "/abs/r.ts"]);
    for (const bad of [{ providerExtensions: "p.ts" }, { providerExtensions: [""] }, { providerExtensions: [1] }]) {
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ parallelReview: bad }));
      await assert.rejects(providerExtensions(agentDir), /must be an array of extension paths/);
    }
    await writeFile(join(agentDir, "settings.json"), "{");
    await assert.rejects(providerExtensions(agentDir), /Cannot read/);
  } finally { await rm(agentDir, { recursive: true, force: true }); }
});
test("a provider extension registers its provider in the reviewer's model runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "review-provider-"));
  try {
    const cwd = join(dir, "runtime"); await mkdir(cwd);
    const extension = join(dir, "provider.js"); await writeFile(extension, providerSource);
    const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false });
    assert.equal(runtime.getModel("fixture-proxy", "fixture-model"), undefined);
    await registerProviders(sdk, runtime, [extension], cwd);
    assert.equal(runtime.getModel("fixture-proxy", "fixture-model")?.baseUrl, "https://proxy.example.invalid");
    assert(await runtime.checkAuth("fixture-proxy"));
    await registerProviders(sdk, runtime, [], cwd);
    await assert.rejects(registerProviders(sdk, runtime, [join(dir, "missing.js")], cwd), /Provider extension failed to load/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
