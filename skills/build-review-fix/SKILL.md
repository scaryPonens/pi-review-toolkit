---
name: build-review-fix
description: Implement a coding task, review the complete change set with review_changes, fix findings, and re-review autonomously until passed or the review-round limit is reached. Use for Build → Review → Fix workflows or /skill:build-review-fix <task>.
---

# Build → Review → Fix → Re-review

You are the developer in the current Pi session. Implement and fix the supplied task yourself; use only the existing independent, parallel, read-only reviewers through `review_changes`. Do not add implementation agents, extensions, lifecycle hooks, or orchestration frameworks. Continue without operator intervention except for blockers or required human judgment.

## Configuration and baseline

- Defaults: `min_severity: medium`, `max_review_rounds: 3`. Accept task-instruction overrides: severity must be `low`, `medium`, `high`, or `critical`; maximum rounds must be a positive integer. Resolve invalid configuration before editing.
- Understand the task, repository instructions, conventions, and relevant tests. Confirm this Pi session is rooted in the target Git repository and `review_changes` is available.
- Before editing, record repository root, branch, HEAD commit, initial staged/unstaged/untracked status, and the immutable review-base commit. Preserve pre-existing operator changes; do not reset, stash, overwrite, or commit them.
- Compatibility: the existing tool accepts only `min_severity`, not a base or review-context argument. It uses the merge base of HEAD and the uniquely configured `refs/remotes/*/HEAD`. Inspect that configuration and record its resolved merge-base commit as the original Git review baseline; record starting HEAD separately. Scope includes all branch changes since that baseline, staged/unstaged edits, and non-ignored untracked files, including pre-existing changes.
- If the requested baseline differs from the tool's effective baseline, the default is missing/ambiguous, or the scope cannot be established, stop as `blocked` and explain the needed configuration. Never silently substitute a baseline, rewrite Git refs, or modify the reviewer extension. Keep the original baseline fixed throughout; do not commit/rebase/reset to narrow subsequent reviews.

## 1. Build

Implement the requested functionality. Add or update appropriate tests, run relevant tests/checks, and fix failures before review. Keep a concise in-session record of configuration, baseline, test results, review rounds, findings, and dispositions.

## 2. Review

For rounds 1 through `max_review_rounds`:

1. Confirm the effective base still equals the original baseline. Invoke `review_changes({ min_severity: <configured severity> })`; each invocation consumes one round. Review the entire accumulated change set, never just the latest fixes. Do not edit while the snapshot/review is running.
2. Read the complete result, including every `review_report` page if directed. Check snapshot/base identity, severity, coverage errors, every applicable reviewer's completion status, and human-judgment requests. A skipped non-applicable reviewer is acceptable; a failed, cancelled, missing, or timed-out required reviewer is not.
3. If the review is `incomplete` or the tool fails, report the failure and partial findings; stop as `incomplete`, never approval. If human judgment is required, notify the operator with the question and rationale and stop as `blocked`, even if technical status is `passed`.
4. Declare `complete` only if the latest result is `passed`, every required reviewer completed successfully, no required judgment remains, and relevant tests pass on the reviewed code. Check that the checkout has not changed since the snapshot; any later code/test change needs another review. A `noChanges: true` result with skipped reviewers is a no-review outcome, not evidence of a completed implementation review.
5. If this was the last allowed round and the success gates were not met, stop as `incomplete`. Report remaining findings and any unverified fixes; do not start an unreviewable extra fix cycle or exceed the limit.
6. Otherwise account for every finding at or above the configured severity. Fix all valid findings and add regression tests where appropriate. For disputed findings, record evidence and reasoning in a concise reviewer-visible repository note (the tool has no context parameter), request explicit verification next round, and keep them unresolved until verified. Never silently ignore a finding or lower severity to manufacture a pass. Do not put secrets in notes.
7. Run relevant tests after fixes. Invoke `review_changes` again within the remaining budget to verify previous findings and discover new ones. Tests passing or your own assessment never substitutes for re-review. Changes to reviewer-visible notes also require review.

If tests cannot run or remain failing, do not claim completion: report the command, failure/blocker, and unresolved work. Stop as `blocked` when external input/configuration is needed, otherwise `incomplete`.

## Final report

Report concisely:
- Implementation summary and original Git baseline.
- Review rounds used / maximum and configured severity.
- Findings discovered, resolved, disputed, and still unresolved (including unverified fixes).
- Test commands and results, including failures or tests not run.
- Final status: `complete`, `blocked`, or `incomplete`, with the reason when not complete.
