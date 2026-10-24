export const reviewers = ["code-reviewer", "pr-test-analyzer", "silent-failure-hunter", "type-design-analyzer", "comment-analyzer", "code-simplifier"] as const;
export type Reviewer = typeof reviewers[number];
export const severities = ["low", "medium", "high", "critical"] as const;
export type Severity = typeof severities[number];
export interface Entry { hash: string; mode: string; text?: string; limitation?: string }
export interface Change { path: string; oldPath?: string; status: "added" | "modified" | "deleted" | "renamed" }
export interface Snapshot {
  id: string; baseRef: string; baseCommit: string; head: string;
  old: Record<string, Entry>; current: Record<string, Entry>;
  changes: Change[]; diff: string; limitations: string[];
}
export interface Instruction { path: string; content: string; appliesTo: string[]; global: boolean }
export interface Policies { instructions: Instruction[]; human?: { path: "HUMAN.md"; content: string; hash: string }; errors: string[] }
export interface Finding {
  severity: Severity; file: string; line: number; side: "old" | "new";
  description: string; suggestedResolution: string;
  instructionReference?: { file: string; section: string };
}
export interface Judgment {
  description: string; question: string; rationale: string; file?: string; line?: number;
  policyReference?: { file: "HUMAN.md"; section: string; excerpt: string };
}
export interface Result {
  schemaVersion: 1; runId: string; snapshotId: string; reviewer: Reviewer;
  findings: Finding[]; humanJudgmentRequests: Judgment[];
}
export interface Selection { reviewer: Reviewer; selected: boolean; reason: string }
export interface Outcome { reviewer: Reviewer; result?: Result; error?: string }
export interface Report {
  runId: string; snapshotId: string; baseRef: string; baseCommit: string; minimumSeverity: Severity;
  status: "incomplete" | "findings" | "passed" | "no-changes";
  humanJudgment: "required" | "not-identified" | "undetermined";
  selection: Selection[]; outcomes: Outcome[]; policies: Policies;
  findings: (Finding & { reviewers: Reviewer[]; instructionReferences: NonNullable<Finding["instructionReference"]>[] })[];
  judgments: (Judgment & { reviewers: Reviewer[] })[];
  limitations: string[];
}
export interface WorkerJob {
  runId: string; snapshot: Snapshot; reviewer: Reviewer; policies: Policies;
  minimumSeverity: Severity; provider: string; model: string;
}
