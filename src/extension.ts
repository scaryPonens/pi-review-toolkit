import { getAgentDir, getPackageDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runReview } from "./run.js";
import { parseArgs, renderReport } from "./report.js";
import type { Report } from "./types.js";

export default function reviewExtension(pi: ExtensionAPI) {
  let active: { controller: AbortController; done: Promise<void> } | undefined;
  let shuttingDown = false;
  const reports = new Map<string, { text: string; expires: number; directory?: string }>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const send = (content: string, details?: unknown) => pi.sendMessage({ customType: "parallel-review", content, display: true, details }, { triggerTurn: false });
  async function deliver(report: Report) {
    const text = renderReport(report);
    const retained = { text, expires: Date.now() + 24 * 60 * 60 * 1000, directory: undefined as string | undefined };
    reports.set(report.runId, retained);
    if (text.length <= 48000) { send(text, { report }); return; }
    const directory = await mkdtemp(join(tmpdir(), "pi-review-report-"));
    retained.directory = directory;
    const path = join(directory, "report.md");
    await writeFile(path, text, { mode: 0o600 });
    const timer = setTimeout(() => {
      reports.delete(report.runId); timers.delete(timer);
      void rm(directory, { recursive: true, force: true }).catch(error => { console.error("Review report expiry cleanup failed", error); });
    }, 24 * 60 * 60 * 1000);
    timer.unref(); timers.add(timer);
    send(`Review status: ${report.status}\nMinimum severity: ${report.minimumSeverity}\nHuman judgment: ${report.humanJudgment}\nBase: ${report.baseRef} (${report.baseCommit})\nSnapshot: ${report.snapshotId}\n${report.findings.length} retained findings; ${report.judgments.length} human-judgment requests.\nThis is a bounded SUMMARY: individual findings, requests, reviewer outcomes, instruction metadata, and coverage details are excluded here. The COMPLETE report is available at ${path}, and through review_report with runId ${report.runId}. Read every page. Artifact retention: up to 24 hours or invoking-session shutdown/reload, whichever comes first; after a crash remove the private directory manually.\n${report.humanJudgment === "required" ? "Handoff: Calling agent must notify the human operator and obtain required judgment. No notification or approval has occurred." : "Technical success is not human approval."}\nThis covers only the captured snapshot.`, { report });
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
  pi.registerCommand("review", {
    description: "Review a stable Git snapshot with independent read-only reviewers; --base <ref> --min-severity low|medium|high|critical",
    handler: async (args, ctx) => {
      try {
        const parsed = parseArgs(args);
        if (active) throw new Error("A /review is already active in this session. Use /review-cancel first.");
        if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("This release supports macOS/Linux only");
        if (VERSION !== "1.3.0") throw new Error(`Pi ${VERSION} is not verified; this version requires Pi 1.3.0 (Node/npm installation)`);
        if (!ctx.model) throw new Error("Select a model and configure its credentials before /review");
        const controller = new AbortController();
        const options = { ...parsed, cwd: ctx.cwd, provider: ctx.model.provider, model: ctx.model.id, sdkPath: join(getPackageDir(), "dist", "index.js"), agentDir: getAgentDir(), signal: controller.signal };
        const done = Promise.resolve().then(async () => {
          try {
            const report = await runReview({ ...options, onProgress: message => { if (!shuttingDown && ctx.hasUI) ctx.ui.setStatus("parallel-review", message); } });
            if (!shuttingDown) await deliver(report);
          } catch (e) {
            if (!shuttingDown) send(`Review status: incomplete\nHuman judgment: undetermined\n${e instanceof Error ? e.message : String(e)}\nNo review approval is implied.`);
          } finally {
            active = undefined;
            if (!shuttingDown && ctx.hasUI) ctx.ui.setStatus("parallel-review", undefined);
          }
        });
        active = { controller, done };
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
