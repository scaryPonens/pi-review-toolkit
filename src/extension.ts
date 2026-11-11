import { getAgentDir, getPackageDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, join, resolve } from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { runReview, type RunOptions } from "./run.js";
import { parseStackArgs, renderStackEntry, renderStackReport, reviewStack, stackSummary, statusLine, type StackArgs, type StackReport, type StackReview } from "./stack-review.js";
import { parseArgs, renderReport } from "./report.js";
import type { Report } from "./types.js";

/**
 * Extensions that reviewers load only to register model providers, such as a provider proxied
 * through an extension. Read from global settings only (`parallelReview.providerExtensions`), never
 * project settings, because each entry runs as code in every reviewer.
 */
export async function providerExtensions(agentDir: string): Promise<string[]> {
  const path = join(agentDir, "settings.json");
  let settings: { parallelReview?: { providerExtensions?: unknown } };
  try { settings = JSON.parse(await readFile(path, "utf8")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`); }
  const paths = settings?.parallelReview?.providerExtensions ?? [];
  if (!Array.isArray(paths) || paths.some(p => typeof p !== "string" || !p.trim())) throw new Error(`parallelReview.providerExtensions in ${path} must be an array of extension paths`);
  return paths.map(p => p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : isAbsolute(p) ? p : resolve(agentDir, p));
}
export default function reviewExtension(pi: ExtensionAPI) {
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  let shuttingDown = false;
  const reports = new Map<string, { text: string; expires: number; directory?: string }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const send = (content: string, details?: unknown) => pi.sendMessage({ customType: "parallel-review", content, display: true, details }, { triggerTurn: false });
  /** Keep a full report readable through review_report; returns the artifact path when it is too long to send inline. */
  async function retain(runId: string, text: string): Promise<string | undefined> {
    const retained = { text, expires: Date.now() + 24 * 60 * 60 * 1000, directory: undefined as string | undefined };
    reports.set(runId, retained);
    if (text.length <= 48000) return undefined;
    const directory = await mkdtemp(join(tmpdir(), "pi-review-report-"));
    retained.directory = directory;
    const path = join(directory, "report.md");
    await writeFile(path, text, { mode: 0o600 });
    const timer = setTimeout(() => {
      reports.delete(runId); timers.delete(timer);
      void rm(directory, { recursive: true, force: true }).catch(error => { console.error("Review report expiry cleanup failed", error); });
    }, 24 * 60 * 60 * 1000);
    timer.unref(); timers.add(timer);
    return path;
  }
  const retention = (path: string, runId: string) => `The COMPLETE report is available at ${path}, and through review_report with runId ${runId}. Read every page. Artifact retention: up to 24 hours or invoking-session shutdown/reload, whichever comes first; after a crash remove the private directory manually.`;
  /** Each pull request's findings go out as soon as its review ends, so the author can start before the stack is done. */
  async function deliverStackEntry(review: StackReview, index: number, total: number) {
    const text = `[${index + 1}/${total}] ${renderStackEntry(review)}`;
    if (text.length <= 48000) { send(text, { review }); return; }
    const path = await retain(`${review.number}-${review.report?.runId ?? "incomplete"}`, text);
    send(`[${index + 1}/${total}] ${statusLine(review).slice(2)}\nThis pull request's full report is too long to show inline. ${retention(path!, `${review.number}-${review.report?.runId}`)}`, { review });
  }
  async function deliverStack(stack: StackReport) {
    const text = renderStackReport(stack), path = await retain(stack.runId, text);
    const summary = [...stackSummary(stack), "", "Each pull request's report was sent above as its review finished."];
    send([...summary, "", path ? `The COMBINED report is available at ${path}, and through review_report with runId ${stack.runId}.` : `The combined report is available through review_report with runId ${stack.runId}.`, "Technical success is not human approval."].join("\n"), { stack });
  }
  async function deliver(report: Report) {
    const text = renderReport(report), path = await retain(report.runId, text);
    if (!path) { send(text, { report }); return; }
    send(`Review status: ${report.status}\nMinimum severity: ${report.minimumSeverity}\nHuman judgment: ${report.humanJudgment}\nBase: ${report.baseRef} (${report.baseCommit})\nSnapshot: ${report.snapshotId}\n${report.findings.length} retained findings; ${report.judgments.length} human-judgment requests.\nThis is a bounded SUMMARY: individual findings, requests, reviewer outcomes, instruction metadata, and coverage details are excluded here. ${retention(path, report.runId)}\n${report.humanJudgment === "required" ? "Handoff: Calling agent must notify the human operator and obtain required judgment. No notification or approval has occurred." : "Technical success is not human approval."}\nThis covers only the captured snapshot.`, { report });
  }
  pi.registerTool({
    name: "review_report", label: "Read review report", description: "Read a complete consolidated /review report in numbered pages. Use nextLine until null. Available in the invoking session for 24 hours.",
    parameters: Type.Object({ runId: Type.String(), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
    async execute(_id, p) {
      const report = reports.get(p.runId);
      if (!report || report.expires < Date.now()) throw new Error("Review report unavailable or expired; consult the saved session or artifact");
      const lines = report.text.split("\n"), start = p.start ?? 1;
      let end = Math.min(lines.length, start - 1 + (p.count ?? 50));
      while (end > start && lines.slice(start - 1, end).join("\n").length > 48000) end--;
      const text = lines.slice(start - 1, end).map((line, i) => `${i + start}: ${line}`).join("\n");
      return { content: [{ type: "text", text: JSON.stringify({ text, nextLine: end < lines.length ? end + 1 : null, totalLines: lines.length }) }], details: undefined };
    },
  });
  type Common = Omit<RunOptions, "minimumSeverity" | "base" | "pr">;
  /** One review run per session, single or stack: shared checks, cancellation, progress and cleanup. */
  function startRun<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, work: (common: Common, aborted: () => boolean) => Promise<T>, onDone?: (result: T) => Promise<void>) {
    if (active) throw new Error("A /review is already active in this session. Use /review-cancel first.");
    if (shuttingDown) throw new Error("Review session is shutting down");
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("This release supports macOS/Linux only");
    if (!["1.3.0", "1.5.0"].includes(VERSION)) throw new Error(`Pi ${VERSION} is not verified; this version requires Pi 1.3.0 or 1.5.0`);
    if (!ctx.model) throw new Error("Select a model and configure its credentials before /review");
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...[signal, ctx.signal].filter((s): s is AbortSignal => !!s)]);
    const model = ctx.model;
    const result = Promise.resolve().then(async () => {
      try {
        combined.throwIfAborted();
        const agentDir = getAgentDir();
        const value = await work({
          cwd: ctx.cwd, provider: model.provider, model: model.id, sdkPath: join(getPackageDir(), "dist", "index.js"), agentDir, signal: combined,
          providerExtensions: await providerExtensions(agentDir),
          onProgress: message => { if (!shuttingDown && ctx.hasUI) ctx.ui.setStatus("parallel-review", message); },
        }, () => combined.aborted);
        if (!shuttingDown) await onDone?.(value);
        return value;
      } finally {
        active = undefined;
        if (!shuttingDown && ctx.hasUI) ctx.ui.setStatus("parallel-review", undefined);
      }
    });
    active = { controller, done: result.then(() => {}, () => {}) };
    return result;
  }
  function startStack(parsed: StackArgs, ctx: ExtensionContext, signal?: AbortSignal, onDone?: (stack: StackReport) => Promise<void>, onPullRequest?: (review: StackReview, index: number, total: number) => Promise<void>) {
    return startRun(ctx, signal, async (common, aborted) => {
      const stack = await reviewStack({ ...common, ...parsed, onPullRequest });
      if (aborted()) { stack.status = "incomplete"; stack.notes.push("Stack review cancelled or deadline exceeded; it is incomplete."); }
      return stack;
    }, onDone);
  }
  function startReview(parsed: ReturnType<typeof parseArgs>, ctx: ExtensionContext, signal?: AbortSignal, onReport?: (report: Report) => Promise<void>) {
    return startRun(ctx, signal, async (common, aborted) => {
      const report = await runReview({ ...common, ...parsed });
      if (aborted()) {
        report.status = "incomplete";
        if (report.humanJudgment !== "required") report.humanJudgment = "undetermined";
        report.limitations.push("Run cancelled or deadline exceeded; review is incomplete.");
      }
      return report;
    }, onReport);
  }
  /** The model-facing shape of one review result, shared by review_changes and review_stack. */
  function structured(report: Report, minimumSeverity: string) {
    return {
      status: report.status === "no-changes" ? "passed" as const : report.status,
      minimumSeverity, noChanges: report.status === "no-changes",
      runId: report.runId, snapshotId: report.snapshotId, baseRef: report.baseRef, baseCommit: report.baseCommit,
      ...(report.pullRequest ? { pullRequest: { ...report.pullRequest } } : {}),
      findings: report.findings.map(f => ({ ...f })),
      reviewers: report.selection.map(s => {
        const outcome = report.outcomes.find(o => o.reviewer === s.reviewer);
        return { reviewer: s.reviewer, status: !s.selected ? "skipped" : outcome?.result && !outcome.error ? "completed" : "failed", reason: s.reason, ...(s.selected && (!outcome?.result || outcome.error) ? { error: outcome?.error ?? "No validated reviewer result" } : {}) };
      }),
      errors: report.limitations, humanJudgment: report.humanJudgment, judgments: report.judgments.map(j => ({ ...j })),
    };
  }
  const severitySchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]);
  pi.registerTool({
    name: "review_changes", label: "Review changes",
    description: "Review a stable Git snapshot using independent parallel read-only reviewers. Waits for completion. Resolve returned findings and invoke again to review your edits. Incomplete is never a pass; human judgment requests require operator handoff. By default reviews the working tree against the configured remote default base. Pass base (a parent branch) to review a branch in a stack, or pr to review a pull request's head commit against its own base branch without checking it out, or pr with base to review that head against another ref, such as the default branch for a stack's combined effect. Nothing is fetched.",
    parameters: Type.Object({
      min_severity: Type.Optional({ ...severitySchema, default: "medium" }),
      base: Type.Optional(Type.String({ minLength: 1, description: "Git ref to diff against, via its merge base with HEAD; for a stacked branch, its parent branch" })),
      pr: Type.Optional(Type.Integer({ minimum: 1, description: "Pull request number; reviews its head commit against its base branch using gh" })),
    }),
    outputSchema: Type.Object({
      status: Type.Union([Type.Literal("passed"), Type.Literal("findings"), Type.Literal("incomplete")]),
      minimumSeverity: severitySchema,
      noChanges: Type.Boolean(),
      findings: Type.Array(Type.Object({ severity: severitySchema, file: Type.String(), line: Type.Integer(), side: Type.Union([Type.Literal("old"), Type.Literal("new")]), description: Type.String(), suggestedResolution: Type.String() })),
      reviewers: Type.Array(Type.Object({ reviewer: Type.String(), status: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped")]), reason: Type.String(), error: Type.Optional(Type.String()) })),
      errors: Type.Array(Type.String()),
      humanJudgment: Type.String(), judgments: Type.Array(Type.Unknown()),
      runId: Type.Optional(Type.String()), snapshotId: Type.Optional(Type.String()), baseRef: Type.Optional(Type.String()), baseCommit: Type.Optional(Type.String()),
      pullRequest: Type.Optional(Type.Object({ number: Type.Integer(), state: Type.String(), url: Type.String(), baseRefName: Type.String(), headRefName: Type.String(), baseOid: Type.String(), headOid: Type.String() })),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const minimumSeverity = p.min_severity ?? "medium";
      try {
        // Also validate direct callers, which may bypass Pi's schema validation.
        const parsed = parseArgs([`--min-severity ${minimumSeverity}`, ...(p.base !== undefined ? [`--base ${p.base}`] : []), ...(p.pr !== undefined ? [`--pr ${p.pr}`] : [])].join(" "));
        const report = await startReview(parsed, ctx, signal);
        const structuredContent = structured(report, minimumSeverity);
        let text = JSON.stringify(structuredContent);
        if (text.length > 48000) {
          await deliver(report);
          text = JSON.stringify({ status: structuredContent.status, minimumSeverity, runId: report.runId, message: "Output exceeds inline limit. Read the COMPLETE actionable findings, reviewer errors, and human judgment requests with review_report, paging until nextLine is null. No findings have been discarded from structuredContent." });
        }
        return { content: [{ type: "text" as const, text }], details: structuredContent, structuredContent, isError: structuredContent.status === "incomplete" };
      } catch (error) {
        const structuredContent = { status: "incomplete" as const, minimumSeverity, noChanges: false, findings: [], reviewers: [], errors: [error instanceof Error ? error.message : String(error)], humanJudgment: "undetermined", judgments: [] };
        return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], details: structuredContent, structuredContent, isError: true };
      }
    },
  });
  pi.registerTool({
    name: "review_stack", label: "Review stack",
    description: "Review every open pull request in the stack under a pull request, bottom first and one at a time, each against its own base exactly as review_changes with pr does. Reports stack shape problems (closed or ambiguous parents, children behind their parent, tool-managed bases) before reviewing; findings whose file a later pull request changes again carry touchedAbove. With whole, also reviews the top pull request against the stack's root. Waits for completion. Incomplete is never a pass; human judgment requests require operator handoff. Nothing is fetched.",
    parameters: Type.Object({
      pr: Type.Integer({ minimum: 1, description: "Top pull request of the stack; every open pull request below it is reviewed" }),
      min_severity: Type.Optional({ ...severitySchema, default: "medium" }),
      whole: Type.Optional(Type.Boolean({ description: "Also review the top pull request's head against the stack's root branch: the stack's combined effect", default: false })),
    }),
    async execute(_id, p, signal, _onUpdate, ctx) {
      const minimumSeverity = p.min_severity ?? "medium";
      try {
        const stack = await startStack(parseStackArgs(`${p.pr} --min-severity ${minimumSeverity}${p.whole ? " --whole" : ""}`), ctx, signal);
        const structuredContent = {
          status: stack.status, minimumSeverity, runId: stack.runId, root: stack.root, notes: stack.notes,
          pullRequests: stack.reviews.map(r => ({ number: r.number, url: r.url, headRefName: r.headRefName, baseRefName: r.baseRefName, ...(r.parent ? { parent: r.parent } : {}), ...(r.behind ? { behind: r.behind } : {}), ...(r.report ? structured(r.report, minimumSeverity) : { status: "incomplete" as const, errors: [r.error ?? "Not reviewed"] }) })),
          ...(stack.whole ? { whole: { number: stack.whole.number, headRefName: stack.whole.headRefName, baseRefName: stack.whole.baseRefName, ...(stack.whole.report ? structured(stack.whole.report, minimumSeverity) : { status: "incomplete" as const, errors: [stack.whole.error ?? "Not reviewed"] }) } } : {}),
        };
        let text = JSON.stringify(structuredContent);
        if (text.length > 48000) {
          const path = await retain(stack.runId, renderStackReport(stack));
          text = JSON.stringify({ status: stack.status, minimumSeverity, runId: stack.runId, summary: stackSummary(stack), message: `Output exceeds inline limit. Read the COMPLETE per-pull-request findings, reviewer errors, and human judgment requests with review_report (runId ${stack.runId}), paging until nextLine is null${path ? `, or at ${path}` : ""}. No findings have been discarded from structuredContent.` });
        }
        return { content: [{ type: "text" as const, text }], details: structuredContent, structuredContent, isError: stack.status === "incomplete" };
      } catch (error) {
        const structuredContent = { status: "incomplete" as const, minimumSeverity, notes: [], pullRequests: [], errors: [error instanceof Error ? error.message : String(error)] };
        return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], details: structuredContent, structuredContent, isError: true };
      }
    },
  });
  pi.registerCommand("review-stack", {
    description: "Review every open pull request in a stack, bottom first, reporting each as it finishes; <top pull request> [--whole] [--min-severity low|medium|high|critical]",
    handler: async (args, ctx) => {
      try {
        const parsed = parseStackArgs(args);
        const done = startStack(parsed, ctx, undefined, deliverStack, deliverStackEntry).catch(e => {
          if (!shuttingDown) send(`Stack review status: incomplete\nHuman judgment: undetermined\n${e instanceof Error ? e.message : String(e)}\nNo review approval is implied.`);
        });
        if (ctx.hasUI) ctx.ui.notify(`Stack review of #${parsed.pr} started. Pull requests are reviewed one at a time; use /review-cancel to stop. Results will be appended without starting an agent turn.`, "info");
        if (ctx.mode === "print" || ctx.mode === "json") await done;
      } catch (e) { send(e instanceof Error ? e.message : String(e)); }
    },
  });
  pi.registerCommand("review", {
    description: "Review a stable Git snapshot with independent read-only reviewers; [--base <ref> | --pr <number>] --min-severity low|medium|high|critical",
    handler: async (args, ctx) => {
      try {
        const parsed = parseArgs(args);
        const done = startReview(parsed, ctx, undefined, deliver).catch(e => {
          if (!shuttingDown) send(`Review status: incomplete\nHuman judgment: undetermined\n${e instanceof Error ? e.message : String(e)}\nNo review approval is implied.`);
        });
        if (ctx.hasUI) ctx.ui.notify("Review started. Use /review-cancel to cancel. Results will be appended without starting an agent turn.", "info");
        if (ctx.mode === "print" || ctx.mode === "json") await done;
      } catch (e) { send(e instanceof Error ? e.message : String(e)); }
    },
  });
  pi.registerCommand("review-cancel", {
    description: "Cancel the active parallel review and clean up only its workers",
    handler: async () => {
      if (!active) { send("No active /review to cancel."); return; }
      active.controller.abort(new Error("Cancelled by /review-cancel"));
      await active.done;
    },
  });
  pi.on("session_start", async () => { shuttingDown = false; });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    active?.controller.abort(new Error("Invoking session shut down or reloaded"));
    await active?.done;
    // Session context retains the structured report; temporary readable artifacts expire at shutdown.
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const report of reports.values()) {
      if (report.directory) {
        try { await rm(report.directory, { recursive: true, force: true }); }
        catch (error) { console.error("Review report shutdown cleanup failed", error); }
      }
    }
    reports.clear();
  });
}
