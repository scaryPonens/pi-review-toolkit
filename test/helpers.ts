import { realpath, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hash } from "../src/snapshot.js";
import type { Entry, Snapshot, WorkerJob, Result, Reviewer } from "../src/types.js";
const exec = promisify(execFile);
export async function repo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-test-")));
  const git = async (...args: string[]) => (await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.invalid"); await git("config", "user.name", "Review Test");
  async function put(path: string, content: string | Buffer) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  await put("src/a.ts", "export const a = 1;\n");
  await put("README.md", "# Fixture\n");
  await put(".gitignore", "ignored*\n");
  await git("add", "."); await git("commit", "-m", "base");
  const base = await git("rev-parse", "HEAD");
  return { root, git, put, base, dispose: () => rm(root, { recursive: true, force: true }) };
}
export const textEntry = (text: string): Entry => ({ hash: hash(text), mode: "100644", text });
export function snapshot(): Snapshot {
  return { id: "snapshot", baseRef: "main", baseCommit: "base", head: "head", old: { "src/a.ts": textEntry("export const a = 1;\n"), "old.ts": textEntry("old\n") }, current: { "src/a.ts": textEntry("export const a = 2;\n"), "HUMAN.md": textEntry("# Compatibility\nAsk before changing a public API.\n") }, changes: [{ path: "src/a.ts", status: "modified" }, { path: "old.ts", status: "deleted" }], diff: "fixture diff\n", limitations: [] };
}
export function job(reviewer: Reviewer = "code-reviewer"): WorkerJob {
  return { runId: "run", snapshot: snapshot(), reviewer, minimumSeverity: "medium", policies: { instructions: [], human: { path: "HUMAN.md", content: "# Compatibility\nAsk before changing a public API.\n", hash: "policy" }, errors: [] }, provider: "fixture", model: "fixture" };
}
export function result(j = job()): Result {
  return { schemaVersion: 1, runId: j.runId, snapshotId: j.snapshot.id, reviewer: j.reviewer, findings: [{ severity: "medium", file: "src/a.ts", line: 1, side: "new", description: "A supported issue", suggestedResolution: "Fix the issue" }], humanJudgmentRequests: [{ description: "API decision", question: "Is the change acceptable?", rationale: "Changes public API", file: "src/a.ts", line: 1, policyReference: { file: "HUMAN.md", section: "Compatibility", excerpt: "Ask before changing a public API." } }] };
}
