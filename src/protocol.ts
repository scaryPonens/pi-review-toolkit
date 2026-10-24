import { validPath } from "./snapshot.js";
import { severities, reviewers, type Result, type WorkerJob } from "./types.js";
export const MAX_RESULT = 1024 * 1024;
type Obj = Record<string, unknown>;
function object(v: unknown, keys: string[], required = keys): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Expected object");
  const o = v as Obj;
  if (Object.keys(o).some(k => !keys.includes(k)) || required.some(k => !Object.hasOwn(o, k))) throw new Error("Unknown or missing result fields");
  return o;
}
function string(v: unknown, max = 12000): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error("Expected bounded nonempty string");
}
function list(v: unknown): asserts v is unknown[] {
  if (!Array.isArray(v) || v.length > 300) throw new Error("Expected array of at most 300 items");
}
function location(file: unknown, line: unknown, side: unknown, job: WorkerJob, optionalLine = false) {
  string(file, 4096);
  if (!validPath(file)) throw new Error(`Invalid repository-relative path: ${file}`);
  if (side !== "old" && side !== "new") throw new Error("Invalid side");
  const entries = side === "old" ? job.snapshot.old : job.snapshot.current;
  const entry = Object.hasOwn(entries, file) ? entries[file] : undefined;
  if (!entry || entry.text === undefined) throw new Error(`Location is not captured text: ${file}`);
  if (optionalLine && line === undefined) return;
  const count = entry.text.length ? entry.text.split("\n").length - (entry.text.endsWith("\n") ? 1 : 0) : 0;
  if (!Number.isSafeInteger(line) || (line as number) < 1 || (line as number) > count) throw new Error(`Invalid line in ${file}`);
}
export function validateResult(value: unknown, job: WorkerJob): Result {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > MAX_RESULT) throw new Error("Result exceeds 1 MiB");
  const o = object(value, ["schemaVersion", "runId", "snapshotId", "reviewer", "findings", "humanJudgmentRequests"]);
  if (o.schemaVersion !== 1 || o.runId !== job.runId || o.snapshotId !== job.snapshot.id || o.reviewer !== job.reviewer || !reviewers.includes(o.reviewer as never)) throw new Error("Result identity/version mismatch");
  list(o.findings); list(o.humanJudgmentRequests);
  for (const value of o.findings) {
    const f = object(value, ["severity", "file", "line", "side", "description", "suggestedResolution", "instructionReference"], ["severity", "file", "line", "side", "description", "suggestedResolution"]);
    if (!severities.includes(f.severity as never)) throw new Error("Invalid severity");
    location(f.file, f.line, f.side, job);
    string(f.description); string(f.suggestedResolution);
    if (f.instructionReference !== undefined) {
      const ref = object(f.instructionReference, ["file", "section"]);
      string(ref.file, 4096); string(ref.section, 1000);
      const instruction = job.policies.instructions.find(i => i.path === ref.file);
      if (!instruction || !instruction.content.includes(ref.section) || (!instruction.global && !instruction.appliesTo.includes(f.file as string))) throw new Error("Invalid instruction reference or applicability");
    }
  }
  for (const value of o.humanJudgmentRequests) {
    const j = object(value, ["description", "question", "rationale", "file", "line", "policyReference"], ["description", "question", "rationale"]);
    string(j.description); string(j.question); string(j.rationale);
    if (j.line !== undefined && j.file === undefined) throw new Error("Judgment line requires a file");
    if (j.file !== undefined) location(j.file, j.line, "new", job, true);
    if (j.policyReference !== undefined) {
      const ref = object(j.policyReference, ["file", "section", "excerpt"]);
      string(ref.section, 1000); string(ref.excerpt);
      if (ref.file !== "HUMAN.md" || !job.policies.human?.content.includes(ref.section) || !job.policies.human.content.includes(ref.excerpt)) throw new Error("Invalid captured HUMAN.md reference");
    }
  }
  return value as Result;
}
export function parseResult(text: string, job: WorkerJob): Result {
  if (Buffer.byteLength(text) > MAX_RESULT) throw new Error("Result exceeds 1 MiB");
  try { return validateResult(JSON.parse(text), job); }
  catch (e) { throw new Error(`Invalid reviewer result: ${e instanceof Error ? e.message : String(e)}`); }
}
