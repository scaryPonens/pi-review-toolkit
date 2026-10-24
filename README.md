# Pi Review Toolkit

A self-contained Pi extension for the **Review** stage only. `/review` captures a stable Git snapshot, runs independent specialized reviewers concurrently, and appends one model-visible consolidated report. It does not fix code, orchestrate developers, approve changes, notify humans, or re-review automatically.

## Install

Requires **Pi 1.3.0 installed through Node/npm**, Node **22.19+**, Git, and either **Herdr 0.8.x** in a managed pane or **tmux 3.2+**. Bun/standalone bundled Pi installations and Windows are not supported by this first release. The runtime version check deliberately fails closed on other Pi versions.

From this package directory:

```sh
npm ci --ignore-scripts
npm run build
pi install /absolute/path/to/pi-review-toolkit
```

Then reload Pi with `/reload`. Alternatively start Pi in the **Git repository you want reviewed**, loading the compiled extension explicitly:

```sh
pi -e /absolute/path/to/pi-review-toolkit/dist/extension.js
```

Local-source installations need the build step. The npm tarball includes `dist/` and bundled prompts. Pi supplies the SDK and TypeBox as peer dependencies; production dependencies are pinned in `package.json` and `package-lock.json`.

## Use

```text
/review [--base <git-ref>] [--min-severity low|medium|high|critical]
/review --base origin/main --min-severity medium
/review --min-severity high
/review-cancel
```

Default threshold: **medium**. Invalid flags, duplicate flags, missing values, and unexpected arguments are rejected before worker startup. Refs cannot contain whitespace. Overlapping runs in one invoking session are rejected; separate invoking sessions have independent run IDs.

When `--base` is absent, the extension accepts exactly one locally configured remote symbolic default (`refs/remotes/*/HEAD`). It never guesses `main`, the current upstream, or another branch, and never fetches. If the default is missing/ambiguous, provide `--base`.

The selected ref is resolved to its merge base with `HEAD`. The report covers changes between that commit and the final working-tree contents: committed branch changes, staged/unstaged changes combined, and non-ignored untracked files. No fetch, stash, checkout, or live index write occurs. An empty diff returns **No changes to review**, launching no workers.

TUI/RPC commands start background work so `/review-cancel` remains usable. Print/JSON command handlers wait for completion, so the process cannot exit before the report is appended. The extension uses `pi.sendMessage(..., { triggerTurn: false })`, not a follow-up/user prompt. JSON/RPC/SDK consumers can inspect the custom `parallel-review` message and its structured `details.report`; plain print output is not a separate stable report protocol.

### Model and credentials

All reviewers use the invoking session's selected **provider and exact model ID**, with medium thinking (clamped by Pi). Workers read Pi's configured credential directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`) for `auth.json` and `models.json`, plus the normal trusted provider environment. No secrets are copied into the model prompt or report.

Only built-in/configured physical models are available in children. Provider extensions, virtual routers, session-only API-key overrides, and custom capabilities from the invoking conversation are **not inherited**. Missing child models/credentials are explicit failed reviewer outcomes, not a fallback to another model. Normal agent/provider retries and compaction are disabled; there is no automatic reviewer retry. Provider credential refresh remains a trusted Pi runtime function.

### Reviewers

- `code-reviewer`: changed behavior, concrete bugs, and captured project rules.
- `pr-test-analyzer`: meaningful behavioral coverage, existing integration coverage, negative/boundary/async cases; no tests executed.
- `silent-failure-hunter`: hidden failures, propagation, unsafe fallbacks, actionable diagnostics.
- `type-design-analyzer`: encapsulation, invariant expression/usefulness/enforcement.
- `comment-analyzer`: comments/documentation that became misleading or inaccurate.
- `code-simplifier`: read-only, behavior-preserving maintainability suggestions, never edits.

Selection is deterministic. Conventional documentation-only changes (`docs/**/*.md`, `docs/**/*.rst`, and root README/CHANGELOG/LICENSE/CONTRIBUTING with md/rst/txt extensions) select code/comment reviewers. All other or uncertain changes conservatively select all six. Renames consider both paths. MDX, arbitrary prompt Markdown, configuration, and unknown languages are not assumed to be inert documentation. Every selected reviewer is required for technical completion.

## Repository guidance

These are this extension's conventions, not Copilot's actual file paths:

- `.agent/reviewer-instructions.md`: repository-wide review guidance.
- `.agent/instructions/**/*.instructions.md`: recursively discovered path-specific guidance.
- Root `HUMAN.md`: circumstances requiring human judgment or approval. No nested inheritance.

All are captured with the snapshot. Missing files are normal. Ignored untracked policy files are still captured as guidance, but are not added to the review diff solely because they were discovered. Files are sorted by repository-relative path; order is not precedence.

Example `.agent/instructions/api.instructions.md`:

```markdown
---
applyTo: "src/api/**/*.ts,src/auth/**/*.ts"
---
# Boundary validation
Validate untrusted inputs at entry points. Do not expose private fields.
```

`applyTo` must be a nonempty YAML string. Comma-separated alternatives match repository-relative `/` paths using **picomatch 4.0.7**: `*`, `**`, and `?` are supported; dotfiles match; matching is case-sensitive. Negation, extglobs, braces, character classes, backslashes, absolute paths, traversal, and empty alternatives are rejected. Pinned options are in `src/policy.ts`: `dot:true`, `nocase:false`, `nonegate:true`, `noext:true`, `nobrace:true`, `posixSlashes:true`.

Placement does not implicitly scope an instruction. Added/modified files match current paths, deleted files match old paths, and renamed files match both. All applicable instructions compose with global guidance; path-specific guidance is never promoted to global guidance. Clear specialization is allowed. Contradictions without clear specialization must become human-judgment requests, not a silent precedence choice. Findings based on a rule cite its captured instruction file and section.

Example `HUMAN.md`:

```markdown
# Public API compatibility
Human approval is required before removing response fields or changing
published compatibility guarantees.

# Privacy
Ask a human before changing retention of personal information.
```

Reviewers explain triggering changes and cite a captured section and verbatim excerpt. Ambiguous policies produce questions, not invented decisions. Instructions may add escalation requirements but cannot waive `HUMAN.md`, safety, snapshot scope, validation, or deterministic filtering. All policy text is data, never permission to execute commands or modify files.

Malformed/unreadable/oversized guidance makes the review **incomplete**. Discovered policy configuration errors stop worker launch. Limits: **64 KiB per policy file**, **256 KiB combined**, **128 policy files**, and **20,000 path-applicability associations**. Files are never silently truncated.

## Snapshot and security boundary

The snapshot is a private serialized manifest containing captured UTF-8 repository context, old/current file hashes and modes, changed paths, and a centrally generated diff. It is **not a detached worktree** and contains no repository executables that reviewers can run. The parent captures twice, compares content manifests, index/HEAD identities and merge-base resolution, and retries up to three times if edits are detected. Snapshot IDs are SHA-256 over the canonical capture data, including policy contents. Later edits do not change an active review. Exact-content/mode renames are recognized; uncertain renames remain addition/deletion pairs.

Each child is a fresh Node process running Pi's SDK with:

- An in-memory conversation and in-memory settings, no invoking history.
- A custom `ResourceLoader` returning **zero extensions, skills, templates, themes, context files, or MCP services**. Neither project `AGENTS.md` nor the normal `/review` entry point loads.
- Only `read_snapshot`, `list_snapshot`, `search_snapshot`, `read_review_diff`, `review_changes`, `submit_review`, and `cannot_complete_review` exposed. There is no shell, write/edit, arbitrary execution, browser, delegation, or recursive orchestration tool.
- Repository tools backed **only by captured data in memory**, never by caller-provided filesystem paths. Reads require captured relative paths and do not follow symlinks; search is literal, not user-supplied regex execution.
- A trusted result writer, outside the repository, that atomically publishes a bounded artifact after validation.

This is a **tool capability boundary, not an OS sandbox**. It prevents model tool access from mutating repository content or reading the live checkout. Trusted Node/Pi/provider modules and trusted orchestration still have host permissions, credentials, temporary state, and model network access. It does not protect against a compromised runtime, malicious installed package, hostile same-user process changing private artifacts, or OS-level attacks. The double-capture consistency check is bounded detection, not an atomic filesystem transaction against an adversarial writer. Unrestricted shell would require a separate OS-enforced sandbox and is not implemented.

No tests, builds, package installs, repository scripts, textconv filters, or external diff programs run as part of review. Trusted capture uses read-only Git plumbing and, for submodule state, read-only Git status with optional index locks disabled. Normal project tooling is not exposed to reviewers.

### Content handling and limits

| Content | Handling |
| --- | --- |
| Regular UTF-8 text up to 1 MiB | Captured with surrounding repository context and reviewable |
| Binary / invalid UTF-8 | Hash and metadata only; changed content makes review incomplete |
| Symlinks | Target-string hash only, never followed by reviewers; changed links make review incomplete |
| Intermediate directory symlinks | Capture fails rather than reading escaped repository context |
| Git LFS pointer | Recognized and unsupported; no hydration/download; changed pointers make review incomplete |
| Hydrated LFS object | Treated as ordinary text/binary/oversized content, according to actual bytes |
| File over 1 MiB | Content hashed but not exposed as text; changed file makes review incomplete |
| Submodule | Opaque gitlink/HEAD and dirty-state metadata only; no subtree context. Changed pointer/dirty subtree makes review incomplete. Unchanged opaque submodules do not create false changes |
| Unsupported context needed by a reviewer | Reviewer must explicitly fail via `cannot_complete_review` |
| Merge conflicts | Fail before reviewer launch |

Maximum **20,000 paths**, **64 MiB total content per old/current capture**, **8 MiB generated diff**, and **5 seconds per file diff computation**. Each ordinary capture Git command has a 30-second budget; each backend operation has 15 seconds. Reads return at most 200 numbered lines/48,000 characters; lists/searches are paginated. Overlong read windows must be narrowed or reported as incomplete, not silently clipped. These deliberately conservative first-version limits may reject large repositories.

Snapshots are private `pi-review-run-*` directories (0700) with snapshot/job files (0400). Worker result files are 0600. Model-facing tools cannot access artifact paths.

## Results, status, and handoff

Results use schema version 1 with runtime validation of identity, structure, bounds, severity, captured paths, old/new line locations, and instruction/policy references. Maximum **1 MiB per reviewer**, **300 findings + 300 judgment requests**, **12,000 characters per substantive string**, **1,000 per section**, and **4,096 per path**. Invalid complete results fail the reviewer; malformed findings are never dropped to manufacture success.

Aggregation is deterministic: validate, retain valid partial outcomes, severity-filter findings, conservatively merge exact whitespace-normalized duplicate issues AND resolutions at the same location, preserve reviewer attribution/references, independently deduplicate judgment requests, then sort by descending severity/file/line/stable textual ties. There is no LLM aggregation stage.

- **incomplete**: any selected worker/configuration/required-coverage/cleanup failure; valid partial findings remain visible.
- **findings**: complete review with retained actionable findings.
- **passed**: complete review without retained findings, **not** human approval.
- **no-changes**: explicit no-review outcome, not `passed: 0 reviewers`.

Human judgment is independent:

- **required**: at least one validated request, even if technical review is incomplete.
- **not-identified**: required processing completed without requests (or explicitly no changes reviewed).
- **undetermined**: review/policy coverage is incomplete without an established request.

Low/medium findings may disappear at a high/critical threshold, but associated judgment requests **never do**. The **calling agent must notify the human and obtain required judgment/approval**. This extension never claims notification or approval occurred.

The full report contains scope identities, selection/completion/failure reasons, loaded instruction applicability, policy presence/hash, all retained findings, unfiltered questions/references, and coverage failures. Reports over 48,000 characters use an explicitly labeled summary plus a complete private Markdown artifact and the read-only `review_report` pagination tool. No findings are silently omitted. Structured report data is also attached to the session message.

## Lifecycle and retention

Herdr is preferred only inside an appropriate managed environment (`HERDR_ENV=1`, `HERDR_PANE_ID`). Background panes use actual returned IDs, `--no-focus`, and only the caller/owned panes for splitting. Otherwise, the tmux backend creates uniquely named detached single-pane sessions and parses returned pane IDs. No backend switching occurs after selection or partial execution. Missing backends fail clearly.

Deadlines: **15 minutes per reviewer**, **20 minutes for the run**, including capture. Cancellation/deadline checks are cooperative during capture; an in-flight bounded Git/backend operation may take its remaining operation budget to unwind. A blocked model never receives automatic approval. Worker exit, terminal idleness, and visible text are not success: only validated matching result artifacts count. Results are never collected by scraping scrollback.

Completion, cancellation, failure, and invoking-session shutdown/reload converge on idempotent owned-pane cleanup. Run snapshots/results are removed only after workers are closed. Cleanup failures make the review incomplete and explicitly retain the run directory for manual recovery. Close only the listed owned resources, then remove that directory. Unrelated panes/sessions are never targeted. Abrupt process/host death cannot execute lifecycle hooks; inspect orphaned private `pi-review-run-*` directories and their `result.json.pid`/job metadata before manual cleanup. Do not blindly kill reused PIDs.

Large readable report artifacts expire after **24 hours or invoking-session shutdown/reload**, whichever comes first. Session messages retain structured report data independently. After a crash, manually remove stale private `pi-review-report-*` directories; they may contain source excerpts. Temp filesystem retention and backups remain under the host's control.

## Development and verification

```sh
npm ci --ignore-scripts
npm run check
npm test
# Opt-in: creates temporary background panes in this Herdr workspace
PI_REVIEW_TEST_HERDR=1 npm test
```

Tests use temporary real Git repositories and a local OpenAI-compatible fixture server; no paid model calls or project scripts. They cover scope, edit detection, index preservation, unsupported content, policies, validation, thresholds, attribution/sorting, partial failures, lifecycle, SDK allowlists, denied mutation/escape attempts, fresh sessions, model-visible delivery, and no automatic continuation. The opt-in Herdr tests verify real child processes, six overlapping provider requests, focus preservation, and worker termination on cancellation.

See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for measured environment, transport decisions, demonstration evidence, and unverified areas. The tmux command contract is unit-tested but was not live-tested on the development host, where tmux was unavailable. Semantic policy interpretation and review quality remain model-dependent; fixture tests do not establish production-model review quality.

## Prompt provenance

The six bundled methodologies are adaptations of Anthropic's [pr-review-toolkit](https://github.com/anthropics/claude-plugins-official/tree/ce721c1f1d5da2c281588818e072ae01a05d2e73/plugins/pr-review-toolkit), pinned to **ce721c1f1d5da2c281588818e072ae01a05d2e73**. Each adapted file prominently describes changes. The upstream Apache-2.0 license and attribution are preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE). No prompts are downloaded at review time. The shared contract replaces upstream output/scoring and Claude Code scope assumptions; numeric confidence/rating scales are not mapped to impact severity.
