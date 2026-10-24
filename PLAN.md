# Pi Extension: Parallel Code Review

## Objective

Build a self-contained TypeScript Pi extension implementing only the **Review** stage of:

`Implement → Review → Resolve Findings → Re-review → Complete`

Expose `/review`, run independent specialized Pi reviewers concurrently through Herdr (or tmux when necessary), and return one consolidated, model-visible report to the invoking session.

Do not implement developer orchestration, automatic fixes, approval workflows, autonomous re-review, or the surrounding development workflow. The calling agent decides what to do with the report and is responsible for notifying a human when judgment is required.

## Reviewer methodology and provenance

Adapt the six reviewers from Anthropic's [pr-review-toolkit](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit):

- `code-reviewer`
- `pr-test-analyzer`
- `silent-failure-hunter`
- `type-design-analyzer`
- `comment-analyzer`
- `code-simplifier`

Pin the source prompts to an upstream commit and preserve applicable license and attribution notices. Bundle adapted prompts; do not depend on downloading them at review time.

Remove Claude Code dependencies and adapt project-guidance references to the supported Pi review instruction files. Preserve the specialized review methodologies while using a shared scope, severity rubric, and structured result contract.

Treat `code-simplifier` as a read-only reviewer that suggests simplifications, never modifies code, and does not inflate cosmetic suggestions to meet the severity threshold.

Upstream confidence and rating scales must not be directly mapped to severity. Confidence and impact are separate concepts; report only findings supported by concrete evidence.

## Command

```text
/review [--base <git-ref>] [--min-severity low|medium|high|critical]
```

Examples:

```text
/review
/review --min-severity medium
/review --min-severity high
/review --min-severity critical
/review --base origin/main --min-severity medium
```

Default minimum severity: `medium`.

Reject invalid severity values, missing option values, unknown flags, and unexpected arguments with a clear usage message. Validate arguments before launching workers.

### Severity rubric

Ascending order: `low < medium < high < critical`.

- **Low:** Minor improvement, clarity concern, or nonessential simplification.
- **Medium:** Meaningful, actionable defect or maintainability risk with limited impact.
- **High:** Major correctness, security, or reliability failure in realistic usage.
- **Critical:** Catastrophic impact, such as severe security exposure or widespread irreversible data loss.

Pass the threshold to every reviewer, but enforce it deterministically in the extension regardless of reviewer behavior. Findings below the threshold are excluded from the consolidated findings and do not affect technical review status.

Human-judgment requests are separate from findings and are never severity-filtered.

## Scope and stable snapshot

### Base selection

1. Use `--base` when supplied.
2. Otherwise use an unambiguous, locally known default target branch.
3. If no unambiguous base exists, request one where interaction is available or fail with clear instructions. Never silently choose an arbitrary branch.

Resolve the merge base between the selected ref and `HEAD`. Review the difference between that commit and a captured working-tree snapshot.

Include:

- Committed branch changes.
- Staged changes.
- Unstaged changes.
- Non-ignored untracked files.

Review final working-tree contents rather than staged and unstaged versions separately. Do not fetch, stash, checkout, or modify the user's index or working tree.

### Snapshot contract

Capture one immutable snapshot before launching reviewers. Assign it a snapshot ID derived from its manifest and contents, and generate the review diff centrally.

- All reviewers receive the same snapshot, diff, base identity, and changed-file manifest.
- Include sufficient surrounding repository context to investigate changed code, not only changed files.
- Reviewers must not independently determine Git scope or read the live working tree.
- Detect changes during capture and retry within a bounded limit or fail, rather than knowingly use an inconsistent snapshot.
- Capture review instruction files and `HUMAN.md` with the snapshot.
- Record the snapshot ID and base commit in the final report.
- Later working-tree changes do not change what the report covers. Clearly identify the report as a review of the captured snapshot.

For the first version, fail clearly on unresolved merge conflicts. Document explicit handling of submodules, Git LFS, binaries, symlinks, and oversized files. Unsupported changed content must be listed as a coverage limitation and make the review `incomplete` when it prevents required review; it must not silently count as reviewed.

An empty diff returns **No changes to review** without launching reviewers. Do not present an unexplained `passed: 0 reviewers` result.

## Isolation and read-only enforcement

Independent sessions and panes isolate conversation history, not filesystem permissions. A detached Git worktree alone is not a read-only boundary.

For the minimal implementation:

- Start a fresh Pi conversation for each reviewer; never inherit the invoking conversation history.
- Expose only explicitly allowlisted, read-only repository tools.
- Do not expose unrestricted shell execution, write/edit tools, arbitrary code execution, or mutable external tools.
- Confine file reads and searches to the snapshot, including resolved symlink targets.
- Disable automatic loading of project extensions and other capabilities that could bypass the read-only tool boundary.
- Do not load the normal `/review` orchestration entry point into child sessions in a way that permits recursive review launches.
- Let trusted extension code write result artifacts outside the repository snapshot.
- Do not execute tests, builds, package installation, or repository scripts.

If unrestricted shell access becomes necessary, require an OS-enforced sandbox with the snapshot mounted read-only. Do not silently downgrade to prompt-only protection.

The guarantee concerns reviewer access to repository content; trusted Pi runtime components may still need controlled access to model credentials and runtime state. Document this boundary accurately.

## Repository reviewer instructions

### Supported locations

- `.agent/reviewer-instructions.md`: repository-wide guidance supplied to every selected reviewer.
- `.agent/instructions/**/*.instructions.md`: recursively discovered path-specific guidance.

These are this extension's conventions. They are analogous to Copilot's repository-wide and path-specific instruction files, not a claim that Copilot uses these exact paths.

Missing instruction files are normal. Load instructions exclusively from the captured snapshot.

### Path-specific format

Require YAML front matter containing a nonempty `applyTo` string:

```markdown
---
applyTo: "src/api/**/*.ts,src/auth/**/*.ts"
---

Review authentication and authorization boundaries.
Flag changes that expose sensitive fields in API responses.
```

Matching rules:

- Match repository-relative paths using `/` separators.
- Comma-separated patterns are alternatives.
- Support `*`, `**`, and `?` with a documented glob implementation and pinned matching options.
- Directory placement of an instruction file does not implicitly scope its applicability.
- Match added and modified files against current paths, deleted files against old paths, and renamed files against both.
- Invalid front matter, empty `applyTo`, or invalid patterns are configuration errors and make the review `incomplete`.

Supply matching instructions with their source paths and applicable changed-file paths. Path-specific guidance must not be treated as repository-wide guidance.

### Composition and conflicts

Apply repository-wide guidance plus all matching path-specific instructions. Sort instruction files by repository-relative path for reproducible prompt construction; ordering does not establish precedence.

Path-specific instructions may explicitly specialize general guidance. If applicable instructions contradict each other without a clear specialization, report a human-judgment request rather than silently choosing one.

Repository instructions cannot override:

- Read-only access, isolation, and extension safety boundaries.
- Scope and snapshot boundaries.
- Structured-output validation.
- Severity filtering and status calculation.
- Human-judgment requirements established by `HUMAN.md`.

Treat instruction contents as review guidance, not permission to execute commands, modify files, or launch agents.

### Validation and provenance

- Report unreadable, malformed, or oversized discovered instruction files; never silently omit or truncate them. Such failures make the review `incomplete`.
- Do not follow instruction-file symlinks outside the snapshot.
- Record loaded paths and their applicability in review metadata.
- Findings based on repository rules should cite the relevant instruction file and section.
- Define and document instruction-size limits before implementation.

## Human judgment and `HUMAN.md`

### Discovery

Look for `HUMAN.md` at the repository root. For the first version, nested policies and inheritance are out of scope.

- If present, capture it with the snapshot and supply it to each selected reviewer.
- Record whether the policy was present and its snapshot identity.
- If absent, continue normally; absence does not prohibit reviewers from identifying issues requiring human judgment.
- If present but unreadable or too large to process within documented limits, report `incomplete`; do not silently ignore it.

### Purpose and interpretation

`HUMAN.md` describes circumstances requiring human judgment or approval, such as:

- Security or privacy trade-offs.
- Changes to business rules or externally visible behavior.
- Ambiguous requirements.
- Compatibility-breaking decisions.
- Regulatory or operational approval.

Treat it as policy data, not executable instructions. It cannot override read-only restrictions, validation, or extension safety boundaries.

Reviewers must explain why a reviewed change triggers the policy and cite the relevant section. Ambiguous policy should produce a judgment request rather than an invented definitive interpretation.

Responsibilities are distinct:

| File | Purpose |
| --- | --- |
| `.agent/reviewer-instructions.md` | How reviewers assess the repository |
| `.agent/instructions/**/*.instructions.md` | Additional review rules for matching paths |
| `HUMAN.md` | When human judgment or approval is required |

Reviewer instructions may identify additional judgment requirements, but cannot waive requirements from `HUMAN.md`.

### Handoff boundary

Return judgment requests as model-visible context to the invoking session. The calling agent must notify the human operator and obtain any required judgment or approval.

The extension must not:

- Infer approval from silence.
- Resolve judgment requests autonomously.
- Claim notification or approval occurred.
- Start fixes, approval workflows, or automatic re-review.

A technical `passed` result does not imply human approval or permission to proceed.

## Reviewer selection

Use deterministic applicability rules, not an extra LLM planning stage. Record why each reviewer was selected or skipped. When applicability is uncertain, include the reviewer.

| Reviewer | Applicability |
| --- | --- |
| `code-reviewer` | Any reviewable change |
| `pr-test-analyzer` | Behavioral code or test changes; tests need not have changed |
| `silent-failure-hunter` | Executable code changes; narrow further only with reliable analysis |
| `type-design-analyzer` | Changes introducing or affecting types, schemas, models, or invariants |
| `comment-analyzer` | Documentation/comment changes, or code changes that may invalidate existing comments |
| `code-simplifier` | Executable code changes; suggestions only |

Prefer conservative inclusion over elaborate language-specific selection heuristics in the first version. All selected reviewers are required for successful completion.

## Execution backend and lifecycle

Prefer existing Herdr capabilities over custom process management.

- Use Herdr when running inside an appropriate Herdr environment.
- Use tmux when Herdr is unavailable and the tmux backend is supported.
- If neither is available, fail clearly.
- Do not switch backends after partial execution without first terminating the original workers.
- Parse actual pane/session IDs from backend responses; do not derive them.
- Preserve user focus and never operate on unrelated panes or sessions.

Start selected reviewers concurrently, with unique run and reviewer identities. Specify per-reviewer and whole-run deadlines. Provide explicit cancellation and reject overlapping `/review` invocations in the same invoking session for the first version.

Completion requires a validated result matching the expected run, snapshot, and reviewer. An idle pane, process exit, or visible approval text is not sufficient.

Use a machine-readable Pi output channel or trusted result writer. Do not collect results by scraping interactive terminal scrollback. Verify the installed Pi and Herdr capabilities during the feasibility spike before choosing the exact transport.

Treat startup failures, blocked workers, timeouts, unexpected exits, cancellation, and invalid output as unsuccessful reviewer outcomes. Do not substitute approvals or automatically retry reviews in the first version.

Cleanup must be idempotent across completion, cancellation, reload, shutdown, and failures. Terminate only workers and close only panes created by the current run. Clean up temporary snapshots and artifacts according to a documented retention policy.

## Structured result contract

Use a versioned, size-bounded schema. The following describes the required data; implementation must add runtime validation rather than relying on TypeScript types alone.

```ts
type Severity = "low" | "medium" | "high" | "critical";

type ReviewerName =
  | "code-reviewer"
  | "pr-test-analyzer"
  | "silent-failure-hunter"
  | "type-design-analyzer"
  | "comment-analyzer"
  | "code-simplifier";

interface HumanJudgmentRequest {
  description: string;
  question: string;
  rationale: string;
  file?: string;
  line?: number;
  policyReference?: {
    file: "HUMAN.md";
    section: string;
    excerpt: string;
  };
}

interface ReviewerResult {
  schemaVersion: 1;
  runId: string;
  snapshotId: string;
  reviewer: ReviewerName;
  findings: Array<{
    severity: Severity;
    file: string;
    line: number;
    side: "old" | "new";
    description: string;
    suggestedResolution: string;
    instructionReference?: {
      file: string;
      section: string;
    };
  }>;
  humanJudgmentRequests: HumanJudgmentRequest[];
}
```

`side` permits locations in deleted code. Missing-test findings may point to the affected implementation. If a judgment request supplies a line, it must also supply a file; add a side discriminator during implementation if old-version locations are needed for judgment requests.

Validate the complete result:

- Expected schema version, run, snapshot, and reviewer identity.
- Required fields, enums, nonempty strings, and bounded collection/string sizes.
- Repository-relative paths without traversal or access outside the snapshot.
- File existence and valid line locations in the relevant old/new version.
- Instruction and policy references against captured files.

Reject malformed results as invalid reviewer outcomes. Do not silently discard malformed findings and count the reviewer as successful.

## Aggregation

Process results in this order:

1. Validate each complete reviewer result.
2. Retain valid results and record failed reviewer outcomes.
3. Filter findings below the configured minimum severity.
4. Conservatively deduplicate retained findings.
5. Deduplicate human-judgment requests separately, without severity filtering.
6. Sort retained findings by descending severity, then file, line, and stable textual tie-breakers.
7. Calculate technical status and human-judgment state.

For the minimal version, merge only exact normalized duplicates of the same issue and suggested resolution. Do not merge merely because two findings share a file and line. Preserve uncertain overlaps separately.

For merged findings, preserve all reviewer attribution and use the highest retained severity. For merged judgment requests, preserve attribution and supporting references. Avoid an additional LLM aggregation stage.

## Status semantics

### Technical status

Use this precedence:

```text
incomplete  if any selected reviewer failed, timed out, was cancelled,
            or returned invalid output; or required scope/policy processing failed
findings    otherwise, if retained findings exist
passed      otherwise
```

An incomplete review still displays valid retained findings and judgment requests from successful reviewers.

Below-threshold findings do not affect technical status. An empty diff is an explicit no-changes outcome, not a misleading successful multi-reviewer review.

### Human judgment

Report an independent field:

```text
Human judgment: required | not-identified | undetermined
```

- `required`: At least one validated judgment request exists, including when technical review is incomplete.
- `not-identified`: Required review and policy processing completed successfully and identified no judgment requests.
- `undetermined`: Coverage or policy processing is incomplete and no validated request establishes that judgment is required.

A no-changes outcome may use `not-identified`, explicitly qualified as no changes reviewed rather than human approval.

Judgment requests are never removed by the severity threshold. For example, a medium-severity compatibility concern can still require human approval when the user selected `--min-severity high`.

## Report delivery

Append the consolidated report to the invoking Pi session as model-visible context. A transient UI notification is insufficient. Do not automatically trigger fixes or a follow-up agent turn.

Include:

- Technical status and minimum severity.
- Human-judgment state and explicit calling-agent handoff when required.
- Base ref, resolved base commit, and snapshot ID.
- Selected, completed, skipped, and failed reviewers, with reasons.
- Loaded instruction paths, applicability, and `HUMAN.md` presence.
- Retained finding counts and sorted actionable findings.
- Judgment requests and supporting policy references.
- Coverage limitations and failure details.

Example:

```text
Review status: findings
Reviewers: 4 completed / 4 selected
Minimum severity: MEDIUM
Human judgment: REQUIRED
Policy: HUMAN.md
Base: origin/main (<commit>)
Snapshot: <snapshot-id>

Critical: 0
High:     2
Medium:   3

Findings:

1. [HIGH] src/dispatch.ts:142
   Reviewer: code-reviewer
   Issue: SoC can exceed the upper bound.
   Fix: Enforce the maximum SoC constraint.

2. [HIGH] src/dispatch.test.ts:85
   Reviewer: pr-test-analyzer
   Issue: Missing boundary-condition coverage.
   Fix: Add tests for maximum SoC.

[Remaining findings omitted here for illustration.]

Human judgment requests:

1. Public API compatibility decision
   Reviewer: code-reviewer
   Policy: HUMAN.md — Breaking changes
   Location: src/api.ts:42
   Question: Is removing this response field acceptable?
   Reason: Policy requires human approval for public API changes.

Handoff: Calling agent must notify the human operator.
```

The real report must not silently omit findings. If a bounded context summary is necessary, attach the complete report as a readable artifact and clearly state what the summary excludes.

## Implementation constraints

- TypeScript using the installed Pi extension API.
- One self-contained extension package exposing `/review`; helper modules, bundled prompts, and an internal reviewer mode are allowed.
- No database, MCP server, persistent orchestration service, autonomous fix loop, or developer-agent management.
- Only ephemeral run state and necessary temporary artifacts.
- Prefer existing Herdr and Pi lifecycle/output facilities.
- No unrestricted reviewer shell access in the minimal version.
- Document model/provider selection and ensure missing credentials or unavailable models fail clearly.
- Keep report data independent of UI rendering so supported non-interactive contexts can consume it.

## Implementation sequence

1. **Feasibility spike**
   - Inspect installed Pi APIs, documentation, and relevant examples.
   - Inspect installed Herdr capabilities from within a supported Herdr environment; inspect tmux capabilities for fallback.
   - Verify isolated startup, suppression of unwanted extension loading, restricted tools, structured output, concurrency, cancellation, and cleanup.
   - Prove the read-only boundary with attempted writes before building the full workflow.
   - Document exact supported versions, environment requirements, and chosen result transport.
2. **Scope, snapshot, and policy loading**
   - Implement base selection and immutable capture without modifying the live checkout or index.
   - Implement instruction discovery, glob matching, provenance, and `HUMAN.md` loading.
3. **Protocol and deterministic aggregation**
   - Implement runtime schemas, severity filtering, conservative deduplication, sorting, status precedence, and independent judgment reporting.
4. **One reviewer end to end**
   - Adapt and pin the first prompt.
   - Demonstrate a restricted fresh Pi session producing a validated result and model-visible report.
5. **Parallel execution**
   - Add all six adapted reviewers, conservative applicability rules, Herdr execution, and tmux fallback.
   - Add bounded deadlines, cancellation, overlapping-run rejection, and idempotent cleanup.
6. **Acceptance testing**
   - Exercise a real Git diff and the failure, policy, and threshold cases below.
7. **Documentation**
   - Cover installation, usage, scope semantics, environment requirements, prompt provenance, policy formats, security boundaries, and limitations.

## Acceptance tests

### Scope and snapshots

- Real Git diff containing committed, staged, unstaged, and non-ignored untracked changes.
- Explicit base, inferred base, invalid ref, and ambiguous/missing default base.
- Empty diff, renames, deletions, conflicts, binary changes, submodules, and documented unsupported content.
- Concurrent working-tree edits during capture and after launch.
- All reviewers receive the same snapshot; live checkout and index remain unchanged.

### Isolation and execution

- Fresh independent contexts with no invoking conversation history.
- Applicable reviewers actually overlap in execution rather than run serially.
- Attempts to write files, execute shell commands, escape via symlinks, or load mutating extensions are denied.
- Startup failure, blocked worker, unexpected exit, timeout, whole-run deadline, cancellation, and overlapping invocation.
- Missing Herdr, tmux fallback, neither backend available, and no duplicate workers after fallback.
- Cleanup touches only resources created by the run.

### Findings and aggregation

- Every supported severity threshold and invalid severity arguments.
- Valid below-threshold findings are excluded and do not affect status.
- Malformed JSON, invalid schema, wrong identities, invalid severity, invalid paths, invalid lines, and oversized output cause incomplete review.
- Exact duplicates retain attribution; distinct issues on the same line remain separate.
- Stable sorting regardless of reviewer completion order.
- Failures take precedence over findings; valid partial findings remain visible.
- Model-visible delivery without automatic continuation or fixes.

### Repository instructions

- Global instructions only, recursive discovery, multiple matching files, and nonmatching patterns.
- Added, modified, deleted, and renamed path matching.
- Invalid front matter, missing/empty `applyTo`, invalid patterns, unreadable files, and size limits.
- Conflicting instructions, explicit specialization, and attempts to override safety rules.
- Instruction changes after capture do not alter an active review.
- Rule-based findings cite the relevant captured instruction source.

### Human judgment

- `HUMAN.md` present, absent, unreadable, oversized, and ambiguous.
- Policy-triggered requests cite the relevant section and explain the trigger.
- Instruction conflicts and additional instruction-defined escalation requirements.
- Judgment requests survive filtering of associated low/medium findings at high/critical thresholds.
- Technical `passed` with human judgment `required`.
- Incomplete review with judgment `required` when a valid request exists, or `undetermined` when none is established.
- Deduplicated requests preserve reviewer attribution.
- No claim that a human has been notified or approved a change.

## Deliverables

- Working Pi extension package with `/review`.
- Six bundled, adapted reviewer prompts with provenance and applicable notices.
- Deterministic result validation, severity filtering, aggregation, and status calculation.
- Snapshot and read-only enforcement implementation.
- Support for `HUMAN.md`, `.agent/reviewer-instructions.md`, and `.agent/instructions/**/*.instructions.md`.
- Automated tests plus a documented real-diff demonstration.
- Installation, usage, policy examples, supported environment/version requirements, and limitations.

## Success criterion

Running `/review --min-severity medium` launches applicable independent Pi reviewers concurrently against the same stable snapshot, prevents reviewer mutation of repository content, applies repository review instructions, and returns only medium-or-higher actionable findings to the invoking session.

The report separately identifies human-judgment requirements, including those arising from `HUMAN.md`, without severity filtering. Failures are explicit and never treated as approvals. The calling agent remains responsible for decisions, human notification, and any subsequent development work.
