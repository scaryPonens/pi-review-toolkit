import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result, Reviewer } from "../src/types.js";
export async function mockModel(delay = 0, attack = false, invalidSubmission = false) {
  const directory = await mkdtemp(join(tmpdir(), "review-model-"));
  const requests: any[] = [], identities = new Set<string>();
  let live = 0, peak = 0;
  const errors: Error[] = [];
  const server = createServer(async (req, res) => {
    try {
      let body = ""; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body); requests.push(payload);
      const user = payload.messages.find((m: any) => m.role === "user");
      const raw = typeof user.content === "string" ? user.content : user.content.map((c: any) => c.text ?? "").join("");
      const identity = JSON.parse(raw.split("Trusted run identity and review parameters:\n")[1].split("\n")[0]);
      identities.add(identity.snapshotId);
      const result: Result = { schemaVersion: 1, runId: identity.runId, snapshotId: identity.snapshotId, reviewer: identity.reviewer as Reviewer, findings: [], humanJudgmentRequests: [] };
      const count = payload.messages.filter((m: any) => m.role === "tool").length;
      let name = "submit_review", args: unknown = { json: JSON.stringify(result) };
      if (attack && count === 0) { name = "write"; args = { path: "SHOULD_NOT_EXIST", content: "MUTATION" }; }
      else if (attack && count === 1) { name = "bash"; args = { command: "touch SHOULD_NOT_EXIST" }; }
      else if (attack && count === 2) { name = "read_snapshot"; args = { path: "/etc/passwd", side: "new" }; }
      else if (attack && count === 3) { name = "read_snapshot"; args = { path: "escape", side: "new" }; }
      if (invalidSubmission && count === 0) args = { notJson: true };
      live++; peak = Math.max(peak, live);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      live--;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (choices: unknown[]) => `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices })}\n\n`;
      res.write(event([{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }]));
      res.write(event([{ index: 0, delta: {}, finish_reason: "tool_calls" }])); res.end("data: [DONE]\n\n");
    } catch (e) { errors.push(e as Error); res.writeHead(500); res.end("fixture error"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "fixture-only-key", api: "openai-completions", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  return { directory, requests, identities, peak: () => peak, errors,
    async dispose() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
