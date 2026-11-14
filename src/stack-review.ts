import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { runReview, type RunOptions } from "./run.js";
import { renderReport } from "./report.js";
import { rootOf } from "./snapshot.js";
import { resolveStack, type Stack } from "./stack.js";
import { severities, type Report, type Severity, type StackPosition } from "./types.js";

const exec = promisify(execFile);
export const stackUsage = "/review-stack <pull request number> [--whole] [--min-severity low|medium|high|critical]";
export interface StackArgs { pr: number; minimumSeverity: Severity; whole: boolean }
export function parseStackArgs(input: string): StackArgs {
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let pr: number | undefined, minimumSeverity: Severity = "medium", severitySeen = false, whole = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--min-severity" && !severitySeen && severities.includes(tokens[i + 1] as Severity)) { minimumSeverity = tokens[++i] as Severity; severitySeen = true; }
    else if (token === "--whole" && !whole) whole = true;
    else if (pr === undefined && /^#?[1-9]\d{0,9}$/.test(token)) pr = Number(token.replace(/^#/, ""));
    else throw new Error(`Invalid or missing argument ${JSON.stringify(token)}. Usage: ${stackUsage}`);
  }
  if (pr === undefined) throw new Error(`Missing pull request number. Usage: ${stackUsage}`);
  return { pr, minimumSeverity, whole };
}

export interface StackReview {
  number: number; url: string; headRefName: string; baseRefName: string; parent?: number;
  /** Set when this pull request does not contain its parent's latest head. */
  behind?: number;
  /** Set on the top pull request's review against the stack's root: the stack's combined effect. */
  whole?: true;
  report?: Report; error?: string;
}
export interface StackReport {
  runId: string; top: number; root: string; minimumSeverity: Severity;
  status: "incomplete" | "findings" | "passed";
  notes: string[]; reviews: StackReview[];
  /** The top pull request's head against the stack's root: the stack's combined effect. Only with `whole`. */
  whole?: StackReview;
}
export interface StackOptions extends Omit<RunOptions, "base" | "pr" | "pullRequest" | "stack"> {
  pr: number;
  whole?: boolean;
  /** Called as each pull request's review finishes, so its findings can be shown or posted before the next starts. */
  onPullRequest?: (review: StackReview, index: number, total: number) => Promise<void>;
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
export async function reviewStack(options: StackOptions, review: typeof runReview = runReview): Promise<StackReport> {
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
  if (options.whole && !await hasCommit(root, stack.root).catch(() => false)) missing.add(stack.root);
  if (missing.size) throw new Error(`Stack commits are not available locally (no fetch is performed). Run: git fetch origin ${[...missing].join(" ")}`);
  const behind = new Map<number, number>();
  for (const p of stack.pullRequests) {
    const parent = stack.pullRequests.find(q => q.number === p.parent);
    if (parent && !await isAncestor(root, parent.headRefOid, p.headRefOid)) {
      behind.set(p.number, parent.number);
      notes.push(`#${p.number} does not contain #${parent.number}'s latest head; rebase it onto #${parent.number}. Its review still covers only its own changes since its merge base.`);
    }
  }

  const order = stack.pullRequests.map(p => p.number);
  const reviews: StackReview[] = [], total = stack.pullRequests.length + (options.whole ? 1 : 0);
  const { whole: _whole, onPullRequest, ...common } = options;
  for (const [i, p] of stack.pullRequests.entries()) {
    const entry: StackReview = { number: p.number, url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName, ...(p.parent ? { parent: p.parent } : {}), ...(behind.has(p.number) ? { behind: behind.get(p.number) } : {}) };
    reviews.push(entry);
    if (options.signal?.aborted) { entry.error = "Not started: the stack review was cancelled"; continue; }
    const parent = stack.pullRequests.find(q => q.number === p.parent);
    const position: StackPosition = { ...(parent ? { parent: { number: parent.number, headRefName: parent.headRefName } } : {}), root: stack.root, below: order.slice(0, i), above: order.slice(i + 1) };
    try {
      const pullRequest = { number: p.number, state: "OPEN", url: p.url, baseRefName: p.baseRefName, headRefName: p.headRefName, baseOid: p.baseRefOid, headOid: p.headRefOid };
      entry.report = await review({ ...common, pr: p.number, pullRequest, stack: position, onProgress: message => options.onProgress?.(`[${i + 1}/${total}] #${p.number}: ${message}`) });
    } catch (e) { entry.error = e instanceof Error ? e.message : String(e); }
    await onPullRequest?.(entry, i, total);
  }
  markTouchedAbove(reviews);

  let whole: StackReview | undefined;
  if (options.whole && stack.pullRequests.length) {
    const top = stack.pullRequests.at(-1)!;
    whole = { number: top.number, url: top.url, headRefName: top.headRefName, baseRefName: stack.root, whole: true };
    if (options.signal?.aborted) whole.error = "Not started: the stack review was cancelled";
    else {
      try {
        const pullRequest = { number: top.number, state: "OPEN", url: top.url, baseRefName: top.baseRefName, headRefName: top.headRefName, baseOid: top.baseRefOid, headOid: top.headRefOid };
        whole.report = await review({ ...common, pr: top.number, base: stack.root, pullRequest, onProgress: message => options.onProgress?.(`[${total}/${total}] whole stack: ${message}`) });
      } catch (e) { whole.error = e instanceof Error ? e.message : String(e); }
    }
    await onPullRequest?.(whole, total - 1, total);
  }

  const all = [...reviews, ...(whole ? [whole] : [])];
  const incomplete = all.some(r => r.error || r.report?.status === "incomplete");
  return {
    runId: randomUUID(), top: options.pr, root: stack.root, minimumSeverity: options.minimumSeverity,
    status: incomplete ? "incomplete" : all.some(r => r.report?.status === "findings") ? "findings" : "passed",
    notes, reviews, ...(whole ? { whole } : {}),
  };
}

/**
 * A finding in a lower pull request whose file a later pull request also changes may already be
 * addressed there; mark it so the reader checks that pull request before acting. File-level only:
 * the reports carry changed paths, not hunks.
 */
export function markTouchedAbove(reviews: StackReview[]) {
  for (const [i, r] of reviews.entries()) {
    if (!r.report) continue;
    for (const f of r.report.findings) {
      const touched = reviews.slice(i + 1).filter(later => later.report?.changes.some(c => c.path === f.file || c.oldPath === f.file)).map(later => later.number);
      if (touched.length) f.touchedAbove = touched;
    }
  }
}

const counts = (report: Report) => [...severities].reverse().map(s => `${report.findings.filter(f => f.severity === s).length} ${s}`).join(", ");
export function statusLine(r: StackReview): string {
  const name = r.whole ? `whole stack: #${r.number} ${r.headRefName} against ${r.baseRefName}` : `#${r.number} ${r.headRefName}`;
  const flags = r.behind ? ` — behind #${r.behind}, rebase first` : "";
  return r.report
    ? `- ${name}: ${r.report.status} (${counts(r.report)}; ${r.report.judgments.length} human-judgment requests)${flags}`
    : `- ${name}: incomplete — ${r.error}${flags}`;
}
export function stackSummary(stack: StackReport): string[] {
  return [
    `Stack review status: ${stack.status}`,
    `Minimum severity: ${stack.minimumSeverity.toUpperCase()}`,
    `Stack: ${[stack.root, ...stack.reviews.map(r => `#${r.number}`)].join(" <- ")}`,
    "",
    "Pull requests (bottom first):",
    ...stack.reviews.map(r => statusLine(r)),
    ...(stack.whole ? [statusLine(stack.whole)] : []),
    "",
    "Stack notes:",
    ...(stack.notes.length ? stack.notes.map(n => `- ${n}`) : ["- None."]),
  ];
}
/** One pull request's section of the stack report, also sent on its own as each review finishes. */
export function renderStackEntry(r: StackReview): string {
  const heading = r.whole
    ? `## Whole stack: #${r.number} ${r.headRefName} against ${r.baseRefName}`
    : `## #${r.number} ${r.headRefName} (base ${r.baseRefName}${r.parent ? `, parent #${r.parent}` : ""}${r.behind ? `; behind #${r.behind}` : ""})`;
  const body = r.report ? renderReport(r.report) : `Review status: incomplete\n${r.error}\nRetry this pull request alone with /review --pr ${r.number}${r.whole ? ` --base ${r.baseRefName}` : ""}.`;
  const touched = r.report?.findings.filter(f => f.touchedAbove?.length) ?? [];
  const note = touched.length ? `\nTouched above: ${touched.map(f => `${f.file}:${f.line} is changed again by ${f.touchedAbove!.map(n => `#${n}`).join(", ")}`).join("; ")}. Check those pull requests before acting on these findings.` : "";
  return [heading, r.url, "", body + note].join("\n");
}
export function renderStackReport(stack: StackReport): string {
  const lines = [...stackSummary(stack), "", "Each section below covers one pull request's own changes against its base. Technical success is not human approval."];
  for (const r of stack.reviews) lines.push("", renderStackEntry(r));
  if (stack.whole) lines.push("", renderStackEntry(stack.whole));
  return lines.join("\n");
}
