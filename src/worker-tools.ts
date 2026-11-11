import type * as SDK from "@earendil-works/pi-coding-agent";
import type * as TB from "typebox";
import type { WorkerJob, Result } from "./types.js";
import { readSnapshot, listSnapshot, searchSnapshot } from "./reader.js";
import { parseResult, MAX_RESULT } from "./protocol.js";

/** Invalid submissions a reviewer may correct before it fails; each is answered with the exact validation error. */
export const MAX_SUBMISSIONS = 3;
export function workerTools(job: WorkerJob, sdk: typeof SDK, { Type }: typeof TB) {
  let result: Result | undefined;
  let failure: string | undefined;
  let rejected = 0;
  /** Count an invalid submission; the last allowed one fails the reviewer. Returns whether another attempt remains. */
  function reject(reason: string): boolean {
    rejected++;
    if (rejected < MAX_SUBMISSIONS) return true;
    failure ??= `Rejected after ${MAX_SUBMISSIONS} invalid submissions. ${reason}`;
    return false;
  }
  const response = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
  const side = Type.Union([Type.Literal("old"), Type.Literal("new")]);
  const offset = Type.Optional(Type.Integer({ minimum: 0 }));
  const tools = [
    sdk.defineTool({
      name: "read_review_diff", label: "Read review diff", description: "Read the centrally generated shared diff, in numbered 200-line pages. Follow nextLine until complete.",
      parameters: Type.Object({ start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      async execute(_id, p) {
        const synthetic = { ...job.snapshot, current: { "review.diff": { text: job.snapshot.diff, hash: "", mode: "100644" } } };
        return response(await readSnapshot(synthetic, "review.diff", "new", p.start, p.count));
      },
    }),
    sdk.defineTool({
      name: "review_changes", label: "Review manifest", description: "Read the shared changed-file manifest, including old paths for renames, in batches of 100.",
      parameters: Type.Object({ offset }),
      async execute(_id, p) {
        const at = p.offset ?? 0, total = job.snapshot.changes.length;
        return response({ changes: job.snapshot.changes.slice(at, at + 100), total, nextOffset: at + 100 < total ? at + 100 : null });
      },
    }),
    sdk.defineTool({
      name: "read_snapshot", label: "Read snapshot", description: "Read numbered lines from a repository file in the snapshot: changed files as captured, unchanged files from their committed contents. No live filesystem access. Use nextLine for pagination.",
      parameters: Type.Object({ path: Type.String(), side, start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      async execute(_id, p) { return response(await readSnapshot(job.snapshot, p.path, p.side, p.start, p.count)); },
    }),
    sdk.defineTool({
      name: "list_snapshot", label: "List snapshot", description: "List every repository path on one side of the snapshot, changed or not, with content limitations, paginated in batches of 100.",
      parameters: Type.Object({ side, offset }),
      async execute(_id, p) { return response(listSnapshot(job.snapshot, p.side, p.offset)); },
    }),
    sdk.defineTool({
      name: "search_snapshot", label: "Search snapshot", description: "Literal case-sensitive text search across all UTF-8 repository files on one side of the snapshot, changed or not. Returns bounded excerpts and nextOffset.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), side, offset }),
      async execute(_id, p) { return response(await searchSnapshot(job.snapshot, p.query, p.side, p.offset)); },
    }),
    sdk.defineTool({
      name: "submit_review", label: "Submit review", description: `Finish the review. Supply the complete ReviewerResult contract serialized as strict JSON (no markdown fences). An invalid submission is answered with the exact validation error; correct it and call submit_review again. After ${MAX_SUBMISSIONS} invalid submissions this reviewer fails.`,
      parameters: Type.Object({ json: Type.String({ maxLength: MAX_RESULT }) }),
      async execute(_id, p) {
        if (result || failure) {
          failure ??= "Duplicate submission after a validated result";
          return { ...response({ error: failure }), terminate: true };
        }
        try { result = parseResult(p.json, job); }
        catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          if (reject(reason)) return response({ error: reason, attemptsRemaining: MAX_SUBMISSIONS - rejected, instruction: "Fix exactly this error and call submit_review again with the complete corrected result." });
          return { ...response({ error: failure }), terminate: true };
        }
        return { ...response({ submitted: true }), terminate: true };
      },
    }),
    sdk.defineTool({
      name: "cannot_complete_review", label: "Report incomplete coverage", description: "Finish unsuccessfully if needed context cannot be reviewed, policy cannot be processed, or the review is blocked. Never substitute an empty approval for missing coverage.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 12000 }) }),
      async execute(_id, p) { failure = p.reason; return { ...response({ error: failure }), terminate: true }; },
    }),
  ];
  return { tools, rejectArguments: reject, completed() {
    if (failure) throw new Error(failure);
    if (!result) throw new Error("Worker exited without a validated submit_review result");
    return result;
  } };
}
