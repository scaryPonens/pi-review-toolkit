import { reviewers, severities, type Selection, type Snapshot, type Policies, type Severity, type Outcome, type Report } from "./types.js";
export const usage = "/review [--base <git-ref>] [--min-severity low|medium|high|critical]";
export function parseArgs(input: string): { base?: string; minimumSeverity: Severity } {
  // Refs and severities cannot contain whitespace, so shell evaluation/quoting is unnecessary.
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  const options: { base?: string; minimumSeverity: Severity } = { minimumSeverity: "medium" };
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i += 2) {
    const flag = tokens[i], value = tokens[i + 1];
    if (!["--base", "--min-severity"].includes(flag) || seen.has(flag) || !value || value.startsWith("-")) throw new Error(`Invalid or missing argument. Usage: ${usage}`);
    seen.add(flag);
    if (flag === "--base") options.base = value;
    else if (severities.includes(value as Severity)) options.minimumSeverity = value as Severity;
    else throw new Error(`Invalid severity ${JSON.stringify(value)}. Usage: ${usage}`);
  }
  return options;
}
export function selectReviewers(snapshot: Snapshot): Selection[] {
  const docsOnly = snapshot.changes.every(c => [c.path, ...(c.oldPath ? [c.oldPath] : [])].every(p => /^(?:docs\/.*\.(?:md|rst)|(?:README|CHANGELOG|LICENSE|CONTRIBUTING)\.(?:md|rst|txt))$/i.test(p)));
  return reviewers.map(reviewer => ({
    reviewer,
    selected: snapshot.changes.length > 0 && (!docsOnly || reviewer === "code-reviewer" || reviewer === "comment-analyzer"),
    reason: snapshot.changes.length === 0 ? "No changes" : docsOnly ? (["code-reviewer", "comment-analyzer"].includes(reviewer) ? "Documentation changes" : "Only known documentation files changed") : "Code, configuration, or uncertain applicability; conservatively included",
  }));
}
const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
const rank = (severity: Severity) => severities.indexOf(severity);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function aggregate(runId: string, snapshot: Snapshot, policies: Policies, minimumSeverity: Severity, selection: Selection[], outcomes: Outcome[], extra: string[] = []): Report {
  const findings: Report["findings"] = [], judgments: Report["judgments"] = [];
  const seenFindings = new Map<string, Report["findings"][number]>(), seenJudgments = new Map<string, Report["judgments"][number]>();
  for (const outcome of [...outcomes].sort((a, b) => compare(a.reviewer, b.reviewer))) {
    if (!outcome.result || outcome.error) continue;
    for (const f of outcome.result.findings) {
      if (rank(f.severity) < rank(minimumSeverity)) continue;
      const key = JSON.stringify([f.file, f.line, f.side, normalize(f.description), normalize(f.suggestedResolution)]);
      const previous = seenFindings.get(key);
      if (previous) {
        if (!previous.reviewers.includes(outcome.reviewer)) previous.reviewers.push(outcome.reviewer);
        if (rank(f.severity) > rank(previous.severity)) previous.severity = f.severity;
        if (f.instructionReference && !previous.instructionReferences.some(r => r.file === f.instructionReference!.file && r.section === f.instructionReference!.section)) previous.instructionReferences.push(f.instructionReference);
      } else {
        const merged = { ...f, reviewers: [outcome.reviewer], instructionReferences: f.instructionReference ? [f.instructionReference] : [] };
        seenFindings.set(key, merged); findings.push(merged);
      }
    }
    for (const j of outcome.result.humanJudgmentRequests) {
      // Reference is part of the key: different supporting policies remain separate.
      const key = JSON.stringify([normalize(j.description), normalize(j.question), normalize(j.rationale), j.file, j.line, j.policyReference]);
      const previous = seenJudgments.get(key);
      if (previous) { if (!previous.reviewers.includes(outcome.reviewer)) previous.reviewers.push(outcome.reviewer); }
      else { const merged = { ...j, reviewers: [outcome.reviewer] }; seenJudgments.set(key, merged); judgments.push(merged); }
    }
  }
  findings.sort((a, b) => rank(b.severity) - rank(a.severity) || compare(a.file, b.file) || a.line - b.line || compare(a.side, b.side) || compare(a.description, b.description) || compare(a.suggestedResolution, b.suggestedResolution));
  judgments.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  const limitations = [...snapshot.limitations, ...policies.errors, ...extra];
  const incomplete = limitations.length > 0 || outcomes.some(o => !!o.error) || selection.some(s => s.selected && !outcomes.some(o => o.reviewer === s.reviewer && o.result && !o.error));
  return {
    runId, snapshotId: snapshot.id, baseRef: snapshot.baseRef, baseCommit: snapshot.baseCommit, minimumSeverity,
    status: incomplete ? "incomplete" : !snapshot.changes.length ? "no-changes" : findings.length ? "findings" : "passed",
    humanJudgment: judgments.length ? "required" : incomplete ? "undetermined" : "not-identified",
    selection, outcomes, policies, findings, judgments, limitations,
  };
}
export function renderReport(report: Report): string {
  const lines = [
    report.status === "no-changes" ? "No changes to review (no reviewers launched)." : `Review status: ${report.status}`,
    `Minimum severity: ${report.minimumSeverity.toUpperCase()}`,
    `Human judgment: ${report.humanJudgment}`,
    `Base: ${report.baseRef} (${report.baseCommit})`, `Snapshot: ${report.snapshotId}`,
    "This report covers the captured snapshot, not subsequent working-tree edits. Technical success is not human approval.",
    `Reviewers: ${report.outcomes.filter(o => o.result && !o.error).length} completed / ${report.selection.filter(s => s.selected).length} selected`,
  ];
  for (const s of report.selection) {
    const o = report.outcomes.find(o => o.reviewer === s.reviewer);
    lines.push(`- ${s.reviewer}: ${!s.selected ? "skipped" : o?.result && !o.error ? "completed" : "failed"} — ${o?.error ?? s.reason}`);
  }
  lines.push(`HUMAN.md: ${report.policies.human ? `present (${report.policies.human.hash})` : "absent or unavailable; see limitations"}`);
  for (const i of report.policies.instructions) {
    lines.push(`Instruction: ${i.path} — ${i.global ? "repository-wide" : i.appliesTo.length ? "path-specific" : "no matching changed paths"}`);
    if (!i.global) for (const path of i.appliesTo) lines.push(`  Applies to: ${path}`);
  }
  for (const s of [...severities].reverse()) lines.push(`${s}: ${report.findings.filter(f => f.severity === s).length}`);
  lines.push("", "Findings:");
  if (!report.findings.length) lines.push("None retained.");
  report.findings.forEach((f, i) => {
    lines.push(`${i + 1}. [${f.severity.toUpperCase()}] ${f.file}:${f.line} (${f.side})`, `   Reviewers: ${f.reviewers.join(", ")}`, `   Issue: ${f.description}`, `   Suggested resolution: ${f.suggestedResolution}`);
    for (const ref of f.instructionReferences) lines.push(`   Instruction: ${ref.file} — ${ref.section}`);
  });
  lines.push("", "Human judgment requests:");
  if (!report.judgments.length) lines.push("None identified in validated results; this is not approval.");
  report.judgments.forEach((j, i) => {
    lines.push(`${i + 1}. ${j.description}`, `   Reviewers: ${j.reviewers.join(", ")}`, `   Question: ${j.question}`, `   Reason: ${j.rationale}`);
    if (j.file) lines.push(`   Location: ${j.file}${j.line ? `:${j.line}` : ""} (new)`);
    if (j.policyReference) lines.push(`   Policy: HUMAN.md — ${j.policyReference.section}`, `   Excerpt: ${j.policyReference.excerpt}`);
  });
  if (report.humanJudgment === "required") lines.push("Handoff: Calling agent must notify the human operator and obtain required judgment/approval. Notification and approval have NOT occurred through this extension.");
  if (report.limitations.length) lines.push("", "Coverage limitations / failures:", ...report.limitations.map(s => `- ${s}`));
  return lines.join("\n");
}
