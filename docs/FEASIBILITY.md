# Feasibility and verification record

## Supported development environment

Measured on the development host:

| Component | Observed |
| --- | --- |
| Pi | 1.3.0, Node/npm installation |
| Node | 22.23.0 |
| npm | 10.9.8 |
| Git | 2.54.0 (Apple Git-157) |
| Herdr | 0.8.0, `HERDR_ENV=1`, managed caller pane |
| tmux | Not installed; command contract tested with a fake command runner only |
| OS | macOS |

Pi's installed SDK, extension declarations, resource loader contracts, command/message APIs, and full-control/structured-output examples were inspected before selecting the design. Runtime code intentionally requires Pi 1.3.0; other versions and standalone/Bun builds need a new compatibility spike rather than an optimistic version assumption.

## Decisions

1. **Use Pi SDK sessions in child Node processes launched through Herdr panes.** Each session is a real Pi `AgentSession` with an in-memory `SessionManager`, explicit settings, and no parent transcript. Pane layout changes are serialized, but model execution overlaps. This avoids driving an interactive terminal or adding a separate orchestration service.
2. **Own resource discovery completely.** The child `ResourceLoader` returns zero extensions, context files, skills, templates, themes, or MCP integrations. No inherited orchestration command or mutable tool can be loaded through a repository file.
3. **Snapshot as data, not a worktree.** Only trusted capture code reads Git/the live checkout. Reviewer read/search/list tools operate over captured manifests in memory. Symlink entries have no readable target content. A filesystem worktree alone would not enforce read-only access.
4. **Trusted structured result tool and atomic file transport.** `submit_review` validates run/snapshot/reviewer identity and the entire bounded schema. A trusted writer publishes an envelope by rename. The parent checks size and validates again against its original snapshot. A separate exit marker diagnoses an exit without output. No terminal text, idle state, or approval phrase is parsed as success.
5. **No shell sandbox because there is no model-callable shell.** Trusted runtime modules retain host permissions. The implemented security claim is about the model-facing repository capability boundary, not containment of malicious runtime code.
6. **No automatic review retries or model fallback.** Errors remain unsuccessful outcomes. Cancellation and deadlines close only owned resources; cleanup failures retain artifacts and mark the review incomplete.

## Demonstration: real Git diff and real Herdr processes

Reproduce from a managed Herdr pane:

```sh
npm ci --ignore-scripts
npm run build
PI_REVIEW_TEST_HERDR=1 npx tsx --test test/herdr.test.ts
```

The test creates a temporary Git repository and branch, adds a committed file, stages one version of an implementation, leaves a different unstaged final version, adds an untracked file and `HUMAN.md`, then invokes the complete capture/orchestration/validation/aggregation pipeline.

A successful measured run reported:

```text
Herdr smoke: 6/6 completed; peak concurrent provider requests=6
snapshot=c93b555f16f7b2fa268724d5917a538794ce446227eaf8d7609d9b97be418279
base=b83ea26495315565e6009187531b971c4aff3a1c
```

These identities are from the temporary fixture, not the user's checkout, and will differ on another run. Assertions check:

- Six independently launched Node/Pi sessions returned matching validated results.
- All received the same snapshot ID.
- All six provider requests actually overlapped.
- The live Git index stayed byte-for-byte unchanged.
- Focus stayed on the invoking pane.
- The created pane set disappeared and unrelated pane identities remained unchanged.

A second real-Herdr test starts six blocked child requests, reads their trusted PID artifacts, cancels the run, verifies `incomplete`/`undetermined`, and confirms each worker process has terminated. It also exercises idempotent backend cleanup.

**The provider is a local OpenAI-compatible deterministic fixture, not a production LLM.** It emits controlled tool calls to test transport and runtime behavior. The fixture's `passed` report is not evidence that a production model analyzed the changes correctly, and no paid model calls were made.

### Regression discovered during repeated testing

Herdr IDs are opaque and progress from digits to letters. A second smoke run exposed an initial numeric-only validation assumption. That assumption was removed; IDs are now taken verbatim from creation responses and checked only for a bounded nonempty/control-free value and ownership uniqueness. Workspace identity is also taken from the backend response/caller environment, not reconstructed from pane IDs. Test-created empty shell panes from the failing probe were explicitly identified and removed. Unit coverage now uses arbitrary alphabetic opaque IDs, and repeated real-Herdr runs passed afterward.

## Isolation proof

The SDK integration tests use a local fixture model to attempt:

1. A `write` call.
2. A `bash` call containing a filesystem mutation command.
3. A `read_snapshot` call for `/etc/passwd`.
4. A read of an external-target symlink entry.

Writes and shell calls are unavailable; absolute/traversal reads and symlink content are rejected. No mutation marker appears. A project extension that throws if loaded and an `AGENTS.md` sentinel are installed in the child test directory: neither is loaded into the session or model request. The test inspects every provider tool declaration to ensure bash/write/codemode/recursive review are absent. Six SDK sessions also demonstrate fresh independent user-message histories.

Malformed final submissions remain failed even if a later model call tries to correct the output. SDK tool-argument validation failures are remembered as permanent reviewer failures. This is separate from ordinary recoverable repository read-window errors.

## Automated coverage

`npm test` builds and exercises the default suite, without creating Herdr panes. At this verification point it contains **36 tests: 34 pass, two opt-in Herdr tests skip by default**. Both opt-in tests were run separately and passed. `npm run check` passes. `npm audit --omit=dev` reports zero vulnerabilities. `npm pack --dry-run` verifies compiled worker/helper files, prompts, notices, and documentation are distributable.

Coverage includes argument validation, base selection, real final-tree scope, ignored guidance, exact renames/deletions, merge conflicts, mutation during capture, post-capture edits, binary/LFS/symlink/oversized handling, opaque submodules, path-specific YAML/globs, policy-size errors, output/path/line/reference validation, all severity thresholds, conservative duplicate attribution, stable ordering, partial failures, blocked workers, cancellation, startup failures, missing backends, SDK resource isolation, overlap rejection, and actual model-visible no-continuation command delivery in non-interactive mode.

## Remaining verification limits

- No live tmux binary was available; the backend is implemented and unit-tested, but requires a live tmux smoke run before relying on it operationally.
- Linux and other Pi/Herdr versions were not tested. The supported runtime checks are intentionally narrow.
- Real production-model findings, judgment-policy interpretation, contradictory natural-language instructions, and prompt-injection resistance as semantic behavior need model-specific evaluation. Tool-denial tests do not prove model reasoning quality. Safety boundaries do not depend on a model obeying the read-only prompt.
- POSIX unreadable-file behavior depends on user permissions. Capture surfaces filesystem errors as incomplete; exhaustive permission/ACL and pathological filesystem tests were not run.
- Double capture is not a filesystem transaction. Concurrent adversarial writes and compromised same-user processes are outside the host trust boundary. Normal edits are detected with bounded retries.
- A hard host/process kill cannot run cleanup handlers. Orphan recovery and private artifact retention are documented in the README.

For a production-model demonstration, load the extension in a disposable real Git repository with configured Pi credentials, select a supported physical model, and run `/review --base <known-ref> --min-severity medium`. Verify all selected reviewers complete and inspect the entire report. Human judgment and any subsequent fixes remain the invoking agent's responsibility.
