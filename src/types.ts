/** Where HUMAN.md may live: `.agents/HUMAN.md` is preferred; the repository root is accepted. */
export type HumanPath = ".agents/HUMAN.md" | "HUMAN.md";
export const humanPaths: readonly HumanPath[] = [".agents/HUMAN.md", "HUMAN.md"];
import type { PullRequest } from "./pr.js";
export const reviewers = ["code-reviewer", "pr-test-analyzer", "silent-failure-hunter", "type-design-analyzer", "comment-analyzer", "code-simplifier"] as const;
export type Reviewer = typeof reviewers[number];
export const severities = ["low", "medium", "high", "critical"] as const;
export type Severity = typeof severities[number];
/** A captured file. Context files carry `blob` instead of `text`: their contents are read from git objects on demand. */
export interface Entry { hash: string; mode: string; text?: string; blob?: string; limitation?: string }
export interface Change { path: string; oldPath?: string; status: "added" | "modified" | "deleted" | "renamed" }
export interface Snapshot {
  id: string; baseRef: string; baseCommit: string; head: string;
  /** Changed and policy files, with full contents, on each side. */
  old: Record<string, Entry>; current: Record<string, Entry>;
  /** Unchanged files, identical on both sides, readable through `objects`. */
  context?: Record<string, Entry>;
  /** Absolute git common directory holding the objects for `context` blobs. */
  objects?: string;
  changes: Change[]; diff: string; limitations: string[];
}
export interface Instruction { path: string; content: string; appliesTo: string[]; global: boolean }
export interface Policies { instructions: Instruction[]; human?: { path: HumanPath; content: string; hash: string }; errors: string[] }
export interface Finding {
  severity: Severity; file: string; line: number; side: "old" | "new";
  description: string; suggestedResolution: string;
  instructionReference?: { file: string; section: string };
}
export interface Judgment {
  description: string; question: string; rationale: string; file?: string; line?: number;
  policyReference?: { file: HumanPath; section: string; excerpt: string };
}
export interface Result {
  schemaVersion: 1; runId: string; snapshotId: string; reviewer: Reviewer;
  findings: Finding[]; humanJudgmentRequests: Judgment[];
}
export interface Selection { reviewer: Reviewer; selected: boolean; reason: string }
export interface Outcome { reviewer: Reviewer; result?: Result; error?: string }
export interface Report {
  runId: string; snapshotId: string; baseRef: string; baseCommit: string; minimumSeverity: Severity;
  /** Set when the review targeted a pull request's commits rather than the working tree. */
  pullRequest?: PullRequest;
  status: "incomplete" | "findings" | "passed" | "no-changes";
  humanJudgment: "required" | "not-identified" | "undetermined";
  selection: Selection[]; outcomes: Outcome[]; policies: Policies;
  findings: (Finding & { reviewers: Reviewer[]; instructionReferences: NonNullable<Finding["instructionReference"]>[]; touchedAbove?: number[] })[];
  judgments: (Judgment & { reviewers: Reviewer[] })[];
  limitations: string[];
  /** The reviewed paths, so a stack review can tell which later pull requests touch a finding's file. */
  changes: Change[];
}
export interface WorkerJob {
  runId: string; snapshot: Snapshot; reviewer: Reviewer; policies: Policies;
  minimumSeverity: Severity; provider: string; model: string;
  /** Absolute paths of operator-configured extensions loaded only to register model providers. */
  providerExtensions?: string[];
  /** The reviewed pull request, when the review targets one. */
  pullRequest?: PullRequest;
  stack?: StackPosition;
}
/** A pull request's place in a stack: its parent pull request, if any, and the branch the stack merges into. */
export interface StackPosition { parent?: { number: number; headRefName: string }; root: string; below: number[]; above: number[] }
