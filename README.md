# Pi Review Toolkit

A self-contained Pi extension for the **Review** stage only. `/review` captures a stable Git snapshot, runs independent specialized reviewers concurrently, and appends one model-visible consolidated report. It does not fix code, orchestrate developers, approve changes, notify humans, or re-review automatically.

## Install

Requires **Pi 1.3.0 or 1.5.0 installed through Node/npm**, Node **22.19+**, Git, and one of: **Herdr 0.8.x** in a managed pane, an **Orca** terminal, or **tmux 3.2+**. Bun/standalone bundled Pi installations and Windows are not supported by this first release. The runtime version check deliberately fails closed on other Pi versions.

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
/review [--base <git-ref> | --pr <number>] [--min-severity low|medium|high|critical]
/review --base origin/main --min-severity medium
/review --base parent-branch          # a branch stacked on parent-branch
/review --pr 45093                   # a pull request, stacked or not
/review-stack 45294 [--min-severity high]   # every open pull request in the stack under #45294
/review --min-severity high
/review-cancel
```

Default threshold: **medium**. Invalid flags, duplicate flags, missing values, and unexpected arguments are rejected before worker startup. Refs cannot contain whitespace. Overlapping runs in one invoking session are rejected; separate invoking sessions have independent run IDs.

When `--base` is absent, the extension accepts exactly one locally configured remote symbolic default (`refs/remotes/*/HEAD`). It never guesses `main`, the current upstream, or another branch, and never fetches. If the default is missing/ambiguous, provide `--base`.

The selected ref is resolved to its merge base with `HEAD`. The report covers changes between that commit and the final working-tree contents: committed branch changes, staged/unstaged changes combined, and non-ignored untracked files. No fetch, stash, checkout, or live index write occurs. An empty diff returns **No changes to review**, launching no workers.

### Stacked branches and pull requests

A stacked branch is reviewed against its parent: `/review --base <parent branch>`. Because the review starts from the merge base, changes added to the parent after the child branched off stay out of the child's review.

`/review --pr <number>` reviews a pull request without checking it out. `gh pr view` supplies the head and base commits, and the review compares exactly those commits, read from git objects alone. The local working tree, index, and current branch are never read, so it works from any checkout. A parent branch that moves mid-review, including tool-managed bases such as `graphite-base/<n>`, cannot change what is reviewed. `--pr` requires an authenticated `gh` and cannot be combined with `--base`. Nothing is fetched: when either commit is missing locally, the review stops and names the `git fetch origin …` to run. The report records the pull request number, URL, state, head and base.

`/review-stack <top pull request>` (and the `review_stack` tool) reviews a whole stack. One `gh pr list` of open pull requests maps the stack below the given pull request. Each base is matched to its parent by branch name or, for tool-managed bases such as `graphite-base/<n>` that are no pull request's head, by pointing at exactly one open pull request's head commit. The walk ends at the repository's default branch. Before any reviewer starts, it reports stack shape problems:

- a bottom pull request whose base belongs to a closed or merged pull request, or to no pull request at all;
- a base shared by several open pull requests, which stops the walk;
- a child that does not contain its parent's latest head;
- other open pull requests stacked on a reviewed one, which are not reviewed.

If any stack commit is missing locally, it stops and names one `git fetch origin …` for all of them. It then reviews the pull requests bottom first, **one at a time**, each exactly as `/review --pr` would, so every review covers only that pull request's own changes. A pull request that cannot be reviewed is reported as incomplete without stopping the rest. The result is one report: the stack, a status line per pull request, the stack notes, then each pull request's full report. The stack is incomplete when any of its pull requests is. `/review-cancel` stops the current review and skips the rest. Each pull request runs all selected reviewers, so a stack of *n* pull requests takes roughly *n* times one review.

TUI/RPC commands start background work so `/review-cancel` remains usable. Print/JSON command handlers wait for completion, so the process cannot exit before the report is appended. The extension uses `pi.sendMessage(..., { triggerTurn: false })`, not a follow-up/user prompt. JSON/RPC/SDK consumers can inspect the custom `parallel-review` message and its structured `details.report`; plain print output is not a separate stable report protocol.

### Model-callable review

Agents can invoke `review_changes({ min_severity: "medium" })` (or `{}` for the same default). It waits for the same parallel, isolated, read-only review used by `/review`. Without arguments the tool uses the configured remote default base; configure exactly one `refs/remotes/*/HEAD` before invoking it. `review_changes({ base: "parent-branch" })` and `review_changes({ pr: 45093 })` match `/review --base` and `/review --pr`; `pr` results also carry a `pullRequest` object.

The result includes `status` (`passed`, `findings`, or `incomplete`), `minimumSeverity`, actionable consolidated `findings` (severity, file, line, old/new side, description, suggested resolution), per-reviewer statuses/errors, coverage errors, snapshot/base identity, and unfiltered human-judgment requests. Data is available as JSON text, `structuredContent`, and `details`. An empty diff maps to `passed` with `noChanges: true` and skipped reviewers; `/review` retains its existing **no-changes** outcome.

Resolve findings, then call the tool again to capture and review the updated checkout. An incomplete review is an error result, never success, even when partial findings are available. Human judgment still requires operator handoff. Large results explicitly direct the agent to read every `review_report` page; full structured results are retained. `/review-cancel` and session shutdown also cancel tool-started runs. No automatic fix/review loop is added.

### Optional Build → Review → Fix skill

Package installation also supplies [`build-review-fix`](skills/build-review-fix/SKILL.md). After installing/updating the package, run `/reload`, then invoke it from the target Git repository:

```text
/skill:build-review-fix <coding task>
/skill:build-review-fix Implement <task>. Use min_severity: high and max_review_rounds: 2.
```

The current Pi agent implements the task, runs tests, calls `review_changes`, fixes actionable findings, and re-reviews. Defaults are medium severity and at most three review calls. Every round covers the accumulated changes against the original configured merge base, not just the latest fixes. Without a `base`, the tool requires exactly one remote symbolic default (`refs/remotes/*/HEAD`); on a stacked branch, the skill passes the parent branch as `base`. The skill stops if that scope cannot be established or changes during the workflow.

Completion requires a latest `passed` review, all applicable reviewers successfully completed, and passing relevant tests. Incomplete reviews, exhausted rounds, and human-judgment requests are reported rather than treated as approval. The extension itself remains read-only; this optional skill supplies workflow instructions, not another runtime or implementation agent.

Loading only `dist/extension.js` with `-e` does not load the companion skill; also pass `--skill /absolute/path/to/pi-review-toolkit/skills/build-review-fix` or install the package. Remove any standalone copy of the same skill to avoid duplicate names. Discovery/package checks do not establish autonomous model behavior; a live implementation → defect review → fix → re-review smoke test remains unverified.

### Model and credentials

All reviewers use the invoking session's selected **provider and exact model ID**, with medium thinking (clamped by Pi). Workers read Pi's configured credential directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`) for `auth.json` and `models.json`, plus the normal trusted provider environment. No secrets are copied into the model prompt or report.

Only built-in/configured physical models are available in children. Provider extensions, virtual routers, session-only API-key overrides, and custom capabilities from the invoking conversation are **not inherited**. Missing child models/credentials are explicit failed reviewer outcomes, not a fallback to another model. Normal agent/provider retries and compaction are disabled; there is no automatic reviewer retry. Provider credential refresh remains a trusted Pi runtime function.

When the session's provider comes from an extension, for example a provider routed through a company proxy, list that extension in the **global** settings file (`~/.pi/agent/settings.json`):

```json
{ "parallelReview": { "providerExtensions": ["~/.pi/extensions/bedrock-runtime.ts"] } }
```

Each reviewer loads those extensions only to register their model providers in its own model runtime. Their tools, commands, and event handlers are never bound to the reviewer session, which still exposes exactly the review tools. Paths may start with `~/`, or be relative to the agent directory. Project settings are not read, because each listed extension runs as code in every reviewer.

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
- `.agents/HUMAN.md` (or root `HUMAN.md`; not both): circumstances requiring human judgment or approval. No nested inheritance.

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

The snapshot is a private serialized manifest containing the full contents of changed and policy files on each side, the blob id and mode of every unchanged file, changed paths, and a centrally generated diff. Unchanged files are identical on both sides, so reviewers read and search them from git objects on demand (`git cat-file` by blob id and `git grep` of the base commit, with lazy fetching disabled), and repository size does not bound a review. Search collects at most 20,000 hits per query and says so when it stops. Changed files are limited to 20,000 paths and 64 MiB of content, and the diff to 8 MiB. It is **not a detached worktree** and contains no repository executables that reviewers can run. The parent captures twice, compares content manifests, ind...

Each child is a fresh Node process running Pi's SDK with:

- An in-memory conversation and in-memory settings, no invoking history.
- A custom `ResourceLoader` returning **zero extensions, skills, templates, themes, context files, or MCP services**. Neither project `AGENTS.md` nor the normal `/review` entry point loads.
- Only `read_snapshot`, `list_snapshot`, `search_snapshot`, `read_review_diff`, `review_changes`, `submit_review`, and `cannot_complete_review` exposed. There is no shell, write/edit, arbitrary execution, browser, delegation, or recursive orchestration tool.
- Repository tools backed **only by captured data**, never by caller-provided filesystem paths: changed files in memory, unchanged files by the blob ids the parent recorded. Reads require captured relative paths and do not follow symlinks; search is literal, not user-supplied regex execution.
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

Results use schema version 1 with runtime validation of identity, structure, bounds, severity, captured paths, old/new line locations, and instruction/policy references. Maximum **1 MiB per reviewer**, **300 findings + 300 judgment requests**, **12,000 characters per substantive string**, **1,000 per section**, and **4,096 per path**. An invalid submission is answered with the exact validation error (for example `findings[2]: unknown fields ["confidence"]`), and the reviewer may correct and resubmit; after **3 invalid submissions** the reviewer fails. Only a fully valid result is accepted, and malformed findings are never dropped to manufacture success.

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

Herdr is preferred only inside an appropriate managed environment (`HERDR_ENV=1`, `HERDR_PANE_ID`). Background panes use actual returned IDs, `--no-focus`, and only the caller/owned panes for splitting. Next, inside an Orca terminal (`ORCA_TERMINAL_HANDLE`), reviewers run in one dedicated `pi-review` tab opened without taking focus: the first reviewer creates the tab, each later one splits the tab's largest pane along its longer side, and the invoking terminal is never resized. Commands run under `/bin/sh` rather than the login shell Orca types into, and closing the last pane removes the tab. The CLI is `ORCA_CLI_COMMAND`, else `orca-dev` in an Orca dev checkout, else `orca`. Otherwise, the tmux backend creates uniquely named detached single-pane sessions and parses returned pane IDs. No backend switching occurs after selection or partial execution. Missing backends fail clearly.

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
