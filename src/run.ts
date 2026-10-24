import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { capture, rootOf, selectBase } from "./snapshot.js";
import { loadPolicies } from "./policy.js";
import { selectReviewers, aggregate } from "./report.js";
import { validateResult, MAX_RESULT } from "./protocol.js";
import { chooseBackend, quote, type Backend } from "./backend.js";
import type { Outcome, Report, Severity, WorkerJob } from "./types.js";

export interface RunOptions {
  cwd: string; base?: string; minimumSeverity: Severity; provider: string; model: string;
  sdkPath: string; agentDir: string; nodePath?: string; signal?: AbortSignal;
  perReviewerMs?: number; wholeRunMs?: number;
  backend?: Backend; onProgress?: (text: string) => void;
}
async function boundedRead(path: string, bytes: number): Promise<string | undefined> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > bytes) throw new Error(`Invalid/oversized worker artifact: ${path}`);
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > bytes) throw new Error("Worker artifact grew beyond limit");
    return text;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
async function waitForWorker(path: string, job: WorkerJob, signal: AbortSignal): Promise<Outcome> {
  while (true) {
    signal.throwIfAborted();
    const text = await boundedRead(path, MAX_RESULT + 20000);
    if (text !== undefined) {
      try {
        const envelope = JSON.parse(text) as { ok?: unknown; result?: unknown; error?: unknown };
        if (!envelope || typeof envelope !== "object" || envelope.ok !== true) throw new Error(typeof envelope?.error === "string" ? envelope.error : "Invalid worker envelope");
        return { reviewer: job.reviewer, result: validateResult(envelope.result, job) };
      } catch (e) { throw new Error(`Invalid/failed ${job.reviewer}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const exit = await boundedRead(`${path}.exit`, 100);
    if (exit !== undefined) throw new Error(`Worker exited (${exit.trim()}) without a validated result`);
    await sleep(150, undefined, { signal });
  }
}
export async function runReview(options: RunOptions): Promise<Report> {
  const runId = randomUUID();
  const deadline = AbortSignal.timeout(options.wholeRunMs ?? 20 * 60 * 1000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const root = await rootOf(options.cwd);
  const baseRef = await selectBase(root, options.base);
  options.onProgress?.("Capturing stable repository snapshot…");
  const snapshot = await capture(root, baseRef, signal);
  const policies = loadPolicies(snapshot), selection = selectReviewers(snapshot);
  if (!snapshot.changes.length) return aggregate(runId, snapshot, policies, options.minimumSeverity, selection, []);
  if (policies.errors.length) return aggregate(runId, snapshot, policies, options.minimumSeverity, selection, selection.filter(s => s.selected).map(s => ({ reviewer: s.reviewer, error: "Policy configuration failed; reviewer not launched" })));
  signal.throwIfAborted();
  const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
  let backend: Backend, directory: string;
  try {
    await access(workerPath);
    await access(options.sdkPath);
    backend = options.backend ?? await chooseBackend();
    directory = await mkdtemp(join(tmpdir(), "pi-review-run-"));
  } catch (e) {
    return aggregate(runId, snapshot, policies, options.minimumSeverity, selection, [], [`Worker startup preflight failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
  const outcomes: Outcome[] = [], extra: string[] = [];
  let cleanupErrors: string[] = [];
  try {
    const snapshotPath = join(directory, "snapshot.json");
    await writeFile(snapshotPath, JSON.stringify(snapshot), { mode: 0o400 });
    options.onProgress?.(`Reviewing snapshot ${snapshot.id.slice(0, 12)} with ${selection.filter(s => s.selected).length} independent reviewers (${backend.name})…`);
    await Promise.all(selection.filter(s => s.selected).map(async selection => {
      const reviewer = selection.reviewer;
      const reviewerSignal = AbortSignal.any([signal, AbortSignal.timeout(options.perReviewerMs ?? 15 * 60 * 1000)]);
      let pane: string | undefined;
      try {
        reviewerSignal.throwIfAborted();
        const cwd = join(directory, reviewer);
        await mkdir(cwd, { mode: 0o700 });
        const job: WorkerJob = { runId, snapshot, reviewer, policies, minimumSeverity: options.minimumSeverity, provider: options.provider, model: options.model };
        const { snapshot: _snapshot, ...descriptor } = job;
        const jobPath = join(cwd, "job.json"), resultPath = join(cwd, "result.json");
        await writeFile(jobPath, JSON.stringify({ ...descriptor, snapshotPath }), { mode: 0o400 });
        const invocation = [options.nodePath ?? process.execPath, workerPath, jobPath, resultPath, options.sdkPath, options.agentDir].map(quote).join(" ");
        // Only trusted orchestration constructs this command. No repository strings are interpolated.
        const shell = `umask 077; ${invocation}; code=$?; printf '%s' "$code" > ${quote(`${resultPath}.exit`)}`;
        pane = await backend.start(shell, cwd, reviewerSignal);
        const outcome = await waitForWorker(resultPath, job, reviewerSignal);
        outcomes.push(outcome);
        options.onProgress?.(`${reviewer}: completed`);
      } catch (e) {
        const reason = reviewerSignal.aborted ? (signal.aborted ? "Cancelled or whole-run deadline exceeded" : "Reviewer deadline exceeded") : e instanceof Error ? e.message : String(e);
        outcomes.push({ reviewer, error: reason });
        options.onProgress?.(`${reviewer}: failed — ${reason}`);
      } finally {
        if (pane) {
          try { await backend.close(pane); } catch (e) { extra.push(`${reviewer}: pane cleanup failed: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }
      return undefined;
    }));
  } catch (e) {
    extra.push(`Run preparation/execution failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    cleanupErrors = await backend.cleanup();
    extra.push(...cleanupErrors);
    if (!cleanupErrors.length) await rm(directory, { recursive: true, force: true });
    else extra.push(`Temporary artifacts retained because workers may still be live: ${directory}. Close only the listed owned panes, then remove this directory.`);
  }
  if (signal.aborted) extra.push("Run cancelled or whole-run deadline exceeded; no human approval is implied.");
  return aggregate(runId, snapshot, policies, options.minimumSeverity, selection, outcomes, extra);
}
