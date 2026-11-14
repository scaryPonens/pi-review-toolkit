import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Snapshot, Entry } from "./types.js";
import { entry as contentEntry, limits, validPath } from "./snapshot.js";

const exec = promisify(execFile);
// Context files are addressed by object id, so reads are immutable. Never fetch from a promisor remote.
const gitEnv = () => ({ ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });
/** Upper bound on search hits collected per query; beyond it, `total` is a lower bound. */
export const MAX_SEARCH_HITS = 20000;
const blobs = new WeakMap<Snapshot, Map<string, Entry>>();
const listings = new WeakMap<Snapshot, Map<string, string[]>>();

export function fileEntries(snapshot: Snapshot, side: "old" | "new"): Record<string, Entry> {
  if (side !== "old" && side !== "new") throw new Error("Invalid side");
  return side === "old" ? snapshot.old : snapshot.current;
}
/** A path's entry on one side: captured if changed (or a policy file), otherwise the shared unchanged context. */
export function lookup(snapshot: Snapshot, path: string, side: "old" | "new"): Entry | undefined {
  const entries = fileEntries(snapshot, side);
  if (Object.hasOwn(entries, path)) return entries[path];
  return snapshot.context && Object.hasOwn(snapshot.context, path) ? snapshot.context[path] : undefined;
}
function cached(snapshot: Snapshot, file: Entry): { cache: Map<string, Entry>; hit?: Entry } {
  if (!snapshot.objects) throw new Error("Unchanged file contents are unavailable for this snapshot");
  let cache = blobs.get(snapshot);
  if (!cache) blobs.set(snapshot, cache = new Map());
  return { cache, hit: cache.get(file.blob!) };
}
const catFile = (snapshot: Snapshot, blob: string) => ["--git-dir", snapshot.objects!, "cat-file", "blob", blob];
const catOptions = () => ({ maxBuffer: limits.file + 1, timeout: 30000, env: gitEnv() });
async function load(snapshot: Snapshot, file: Entry): Promise<Entry> {
  if (file.text !== undefined || !file.blob) return file;
  const { cache, hit } = cached(snapshot, file);
  if (hit) return hit;
  const loaded = contentEntry((await exec("git", catFile(snapshot, file.blob), { ...catOptions(), encoding: "buffer" })).stdout, file.mode);
  cache.set(file.blob, loaded);
  return loaded;
}
/** Synchronous `load`, for result validation, which checks at most a few hundred locations. */
export function contextText(snapshot: Snapshot, file: Entry): Entry {
  if (file.text !== undefined || !file.blob) return file;
  const { cache, hit } = cached(snapshot, file);
  if (hit) return hit;
  const loaded = contentEntry(execFileSync("git", catFile(snapshot, file.blob), { ...catOptions(), stdio: ["ignore", "pipe", "pipe"] }), file.mode);
  cache.set(file.blob, loaded);
  return loaded;
}
export async function readSnapshot(snapshot: Snapshot, path: string, side: "old" | "new", start = 1, count = 200) {
  if (!validPath(path)) throw new Error("Only repository-relative snapshot paths are allowed");
  const found = lookup(snapshot, path, side);
  if (!found) throw new Error("File not in snapshot");
  const file = await load(snapshot, found);
  if (file.text === undefined) throw new Error(`Unsupported captured content: ${file.limitation}`);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error("Invalid read window");
  const lines = file.text.length ? file.text.split("\n") : [];
  if (file.text.endsWith("\n")) lines.pop();
  // Very long lines are never silently truncated. Use a smaller file or fail the review.
  const output = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join("\n");
  if (output.length > 48000) throw new Error("Read window exceeds 48000 characters; request fewer lines, or report cannot_complete_review");
  return { text: output, totalLines: lines.length, nextLine: start - 1 + count < lines.length ? start + count : null };
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function listSnapshot(snapshot: Snapshot, side: "old" | "new", offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  let cache = listings.get(snapshot);
  if (!cache) listings.set(snapshot, cache = new Map());
  let paths = cache.get(side);
  if (!paths) cache.set(side, paths = [...new Set([...Object.keys(fileEntries(snapshot, side)), ...Object.keys(snapshot.context ?? {})])].sort(compare));
  return { files: paths.slice(offset, offset + 100).map(path => ({ path, limitation: lookup(snapshot, path, side)!.limitation })), total: paths.length, nextOffset: offset + 100 < paths.length ? offset + 100 : null };
}
type Hit = { path: string; line: number; excerpt: string };
const excerpt = (text: string, index: number, query: string) => text.slice(Math.max(0, index - 100), index + query.length + 100);
/** Search unchanged context files in the base commit with `git grep`, which is fast at repository scale. */
async function searchContext(snapshot: Snapshot, query: string, max: number): Promise<{ hits: Hit[]; truncated: boolean }> {
  const hits: Hit[] = [], context = snapshot.context, objects = snapshot.objects;
  // A pattern containing a newline is several patterns to git grep; it cannot match within one line anyway.
  if (!context || !objects || /[\n\r\0]/.test(query) || max <= 0) return { hits, truncated: false };
  const prefix = `${snapshot.baseCommit}:`;
  const child = spawn("git", ["--git-dir", objects, "grep", "-F", "-I", "-n", "-z", "--no-color", "-e", query, snapshot.baseCommit, "--"], { env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "", truncated = false;
  child.stderr.on("data", chunk => { if (stderr.length < 4000) stderr += chunk; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
  try {
    // Rows are `<commit>:<path>\0<line>\0<text>\n`; split on \n only, since a matched line may contain \r.
    let pending = "";
    rows: for await (const chunk of child.stdout.setEncoding("utf8")) {
      const rows = (pending + chunk).split("\n");
      pending = rows.pop()!;
      for (const row of rows) {
        const [name, line, ...rest] = row.split("\0");
        const path = name.startsWith(prefix) ? name.slice(prefix.length) : name, text = rest.join("\0");
        if (!context[path]?.blob) continue; // changed files are searched from captured text; unsupported ones are skipped
        if (hits.length >= max) { truncated = true; child.kill("SIGKILL"); break rows; }
        hits.push({ path, line: Number(line), excerpt: excerpt(text, text.indexOf(query), query) });
      }
    }
    const code = await exit;
    if (!truncated && code !== 0 && code !== 1) throw new Error(`Search of unchanged files failed: ${stderr.trim() || `git grep exited ${code}`}`);
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
  return { hits, truncated };
}
export async function searchSnapshot(snapshot: Snapshot, query: string, side: "old" | "new", offset = 0) {
  if (!query || query.length > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid literal search/offset");
  const captured: Hit[] = [];
  let truncated = false;
  for (const [path, entry] of Object.entries(fileEntries(snapshot, side)).sort(([a], [b]) => compare(a, b))) {
    if (entry.text === undefined) continue;
    for (const [i, text] of entry.text.split("\n").entries()) {
      const index = text.indexOf(query);
      if (index < 0) continue;
      if (captured.length >= MAX_SEARCH_HITS) { truncated = true; break; }
      captured.push({ path, line: i + 1, excerpt: excerpt(text, index, query) });
    }
  }
  const context = await searchContext(snapshot, query, MAX_SEARCH_HITS - captured.length);
  const all = [...captured, ...context.hits].sort((a, b) => compare(a.path, b.path) || a.line - b.line);
  truncated ||= context.truncated;
  const hits = all.slice(offset, offset + 100);
  return {
    hits, total: all.length, ...(truncated ? { totalIsLowerBound: true } : {}),
    nextOffset: offset + hits.length < all.length ? offset + hits.length : null,
    note: `Literal search of supported UTF-8 text only; excerpts, not complete lines${truncated ? `; stopped after ${MAX_SEARCH_HITS} hits, so use a more specific query` : ""}`,
  };
}
