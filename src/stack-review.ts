import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { runReview, type RunOptions } from "./run.js";
import { renderReport } from "./report.js";
import { rootOf } from "./snapshot.js";
import { resolveStack, type Stack } from "./stack.js";
import { severities, type Report, type Severity } from "./types.js";

const exec = promisify(execFile);
export const stackUsage = "/review-stack <pull request number> [--min-severity low|medium|high|critical]";
export function parseStackArgs(input: string): { pr: number; minimumSeverity: Severity } {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let pr: number | undefined, minimumSeverity: Severity = "medium", severitySeen = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--min-severity" && !severitySeen && severities.includes(tokens[i + 1] as Severity)) { minimumSeverity = tokens[++i] as Severity; severitySeen = true; }
    else if (pr === undefined && /^#?[1-9]\d{0,9}$/.test(token)) pr = Number(token.replace(/^#/, ""));
    else throw new Error(`Invalid or missing argument ${JSON.stringify(token)}. Usage: ${stackUsage}`);
  }
  if (pr === undefined) throw new Error(`Missing pull request number. Usage: ${stackUsage}`);
  return { pr, minimumSeverity };
}

export interface StackReview {
  number: number; url: string; headRefName: string; baseRefName: string; parent?: number;
  report?: Report; error?: string;
}
export interface StackReport {
  runId: string; top: number; root: string; minimumSeverity: Severity;
  status: "incomplete" | "findings" | "passed";
  notes: string[]; reviews: StackReview[];
}
const isAncestor = async (root: string, ancestor: string, descendant: string) => {
  try { await exec("git", ["--no-optional-locks", "merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, timeout: 30000 }); return true; }
  catch (e) { if ((e as { code?: number }).code === 1) return false; throw e; }
};
const hasCommit = async (root: string, oid: string) => {
  try { await exec("git", ["--no-optional-locks", "cat-file", "-e", `${oid}^{commit}`], { cwd: root, timeout: 30000 }); return true; }
  catch { return false; }
};

/**
 * Review every pull request in the stack under `pr`, bottom first and one at a time, each against its
 * own base exactly as `/review --pr` does. Stack shape problems are reported before any reviewer starts.
 */
export async function reviewStack(options: Omit<RunOptions, "base" | "pr"> & { pr: number }, review: typeof runReview = runReview): Promise<StackReport> {
  const root = await rootOf(options.cwd);
  options.onProgress?.(`Resolving the stack under #${options.pr}…`);
  const stack: Stack = await resolveStack(root, options.pr, options.gh);
  const notes = [...stack.notes];

  // One fetch command for every missing commit, instead of failing pull request by pull request.
  const missing = new Set<string>();
  for (const p of stack.pullRequests) {
    if (!await hasCommit(root, p.headRefOid)) missing.add(`refs/pull/${p.number}/head`);
    if (!await hasCommit(root, p.baseRefOid)) missing.add(p.baseRefName);
  }
  if (missing.size) throw new Error(`Stack commits are not available locally (no fetch is performed). Run: git fetch origin ${[...missing].join(" ")}`);
  for (const p of stack.pullRequests) {
    const parent = stack.pullRequests.find(q => q.number === p.parent);
    if (parent && !await isAncestor(root, parent.headRefOid, p.headRefOid)) notes.push(`#${p.number} does not contain #${parent.number}'s latest head; rebase it onto #${parent.number}. Its review still covers only its own changes since its merge base.`);
  }

  const reviews: StackReview[] = [], total = stack.pullRequests.length;
  for (const [i, p] of stack.pullRequests.entries()) {
    const entry: StackReview = { number: p.number, url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName, ...(p.parent ? { parent: p.parent } : {}) };
    reviews.push(entry);
    if (options.signal?.aborted) { entry.error = "Not started: the stack review was cancelled"; continue; }
    try {
      const pullRequest = { number: p.number, state: "OPEN", url: p.url, baseRefName: p.baseRefName, headRefName: p.headRefName, baseOid: p.baseRefOid, headOid: p.headRefOid };
      entry.report = await review({ ...options, pr: p.number, pullRequest, onProgress: message => options.onProgress?.(`[${i + 1}/${total}] #${p.number}: ${message}`) });
    } catch (e) { entry.error = e instanceof Error ? e.message : String(e); }
  }
  const incomplete = reviews.some(r => r.error || r.report?.status === "incomplete");
  return {
    runId: randomUUID(), top: options.pr, root: stack.root, minimumSeverity: options.minimumSeverity,
    status: incomplete ? "incomplete" : reviews.some(r => r.report?.status === "findings") ? "findings" : "passed",
    notes, reviews,
  };
}

const counts = (report: Report) => [...severities].reverse().map(s => `${report.findings.filter(f => f.severity === s).length} ${s}`).join(", ");
export function stackSummary(stack: StackReport): string[] {
  return [
    `Stack review status: ${stack.status}`,
    `Minimum severity: ${stack.minimumSeverity.toUpperCase()}`,
    `Stack: ${[stack.root, ...stack.reviews.map(r => `#${r.number}`)].join(" <- ")}`,
    "",
    "Pull requests (bottom first):",
    ...stack.reviews.map(r => r.report
      ? `- #${r.number} ${r.headRefName}: ${r.report.status} (${counts(r.report)}; ${r.report.judgments.length} human-judgment requests)`
      : `- #${r.number} ${r.headRefName}: incomplete — ${r.error}`),
    "",
    "Stack notes:",
    ...(stack.notes.length ? stack.notes.map(n => `- ${n}`) : ["- None."]),
  ];
}
export function renderStackReport(stack: StackReport): string {
  const lines = [...stackSummary(stack), "", "Each section below covers one pull request's own changes against its base. Technical success is not human approval."];
  for (const r of stack.reviews) {
    lines.push("", `## #${r.number} ${r.headRefName} (base ${r.baseRefName}${r.parent ? `, parent #${r.parent}` : ""})`, r.url, "");
    lines.push(r.report ? renderReport(r.report) : `Review status: incomplete\n${r.error}\nRetry this pull request alone with /review --pr ${r.number}.`);
  }
  return lines.join("\n");
}
