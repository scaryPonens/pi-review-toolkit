import type * as SDK from "@earendil-works/pi-coding-agent";
import type * as TB from "typebox";
import type { WorkerJob, Result } from "./types.js";
import { readSnapshot, listSnapshot, searchSnapshot } from "./reader.js";
import { parseResult, MAX_RESULT } from "./protocol.js";

export function workerTools(job: WorkerJob, sdk: typeof SDK, { Type }: typeof TB) {
  let result: Result | undefined;
  let failure: string | undefined;
  const response = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });
  const side = Type.Union([Type.Literal("old"), Type.Literal("new")]);
  const offset = Type.Optional(Type.Integer({ minimum: 0 }));
  const tools = [
    sdk.defineTool({
      name: "read_review_diff", label: "Read review diff", description: "Read the centrally generated shared diff, in numbered 200-line pages. Follow nextLine until complete.",
      parameters: Type.Object({ start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      async execute(_id, p) {
        const synthetic = { ...job.snapshot, current: { "review.diff": { text: job.snapshot.diff, hash: "", mode: "100644" } } };
        return response(readSnapshot(synthetic, "review.diff", "new", p.start, p.count));
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
      name: "read_snapshot", label: "Read snapshot", description: "Read numbered lines from a captured repository file. No live filesystem access. Use nextLine for pagination.",
      parameters: Type.Object({ path: Type.String(), side, start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }),
      async execute(_id, p) { return response(readSnapshot(job.snapshot, p.path, p.side, p.start, p.count)); },
    }),
    sdk.defineTool({
      name: "list_snapshot", label: "List snapshot", description: "List captured repository paths and content limitations, paginated in batches of 100.",
      parameters: Type.Object({ side, offset }),
      async execute(_id, p) { return response(listSnapshot(job.snapshot, p.side, p.offset)); },
    }),
    sdk.defineTool({
      name: "search_snapshot", label: "Search snapshot", description: "Literal case-sensitive text search within captured UTF-8 repository files. Returns bounded excerpts and nextOffset.",
      parameters: Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), side, offset }),
      async execute(_id, p) { return response(searchSnapshot(job.snapshot, p.query, p.side, p.offset)); },
    }),
    sdk.defineTool({
      name: "submit_review", label: "Submit review", description: "Finish the review. Supply the complete ReviewerResult contract serialized as strict JSON (no markdown fences). A malformed submission fails this reviewer permanently.",
      parameters: Type.Object({ json: Type.String({ maxLength: MAX_RESULT }) }),
      async execute(_id, p) {
        try {
          if (result || failure) throw new Error("Duplicate or previously invalid submission");
          result = parseResult(p.json, job);
        } catch (e) { failure ??= e instanceof Error ? e.message : String(e); }
        return { ...response(failure ? { error: failure } : { submitted: true }), terminate: true };
      },
    }),
    sdk.defineTool({
      name: "cannot_complete_review", label: "Report incomplete coverage", description: "Finish unsuccessfully if needed context cannot be reviewed, policy cannot be processed, or the review is blocked. Never substitute an empty approval for missing coverage.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 12000 }) }),
      async execute(_id, p) { failure = p.reason; return { ...response({ error: failure }), terminate: true }; },
    }),
  ];
  return { tools, invalidate(reason: string) { failure = reason; }, completed() {
    if (failure) throw new Error(failure);
    if (!result) throw new Error("Worker exited without a validated submit_review result");
    return result;
  } };
}
