import type { Snapshot, Entry } from "./types.js";
import { validPath } from "./snapshot.js";
export function fileEntries(snapshot: Snapshot, side: "old" | "new"): Record<string, Entry> {
  if (side !== "old" && side !== "new") throw new Error("Invalid side");
  return side === "old" ? snapshot.old : snapshot.current;
}
export function readSnapshot(snapshot: Snapshot, path: string, side: "old" | "new", start = 1, count = 200) {
  if (!validPath(path)) throw new Error("Only repository-relative snapshot paths are allowed");
  const entries = fileEntries(snapshot, side);
  const file = Object.hasOwn(entries, path) ? entries[path] : undefined;
  if (!file) throw new Error("File not in snapshot");
  if (file.text === undefined) throw new Error(`Unsupported captured content: ${file.limitation}`);
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 200) throw new Error("Invalid read window");
  const lines = file.text.length ? file.text.split("\n") : [];
  if (file.text.endsWith("\n")) lines.pop();
  // Very long lines are never silently truncated. Use a smaller file or fail the review.
  const output = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join("\n");
  if (output.length > 48000) throw new Error("Read window exceeds 48000 characters; request fewer lines, or report cannot_complete_review");
  return { text: output, totalLines: lines.length, nextLine: start - 1 + count < lines.length ? start + count : null };
}
export function listSnapshot(snapshot: Snapshot, side: "old" | "new", offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  const entries = fileEntries(snapshot, side), paths = Object.keys(entries).sort();
  return { files: paths.slice(offset, offset + 100).map(path => ({ path, limitation: entries[path].limitation })), total: paths.length, nextOffset: offset + 100 < paths.length ? offset + 100 : null };
}
export function searchSnapshot(snapshot: Snapshot, query: string, side: "old" | "new", offset = 0) {
  if (!query || query.length > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid literal search/offset");
  const hits: { path: string; line: number; excerpt: string }[] = [];
  let total = 0;
  for (const [path, entry] of Object.entries(fileEntries(snapshot, side)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (entry.text === undefined) continue;
    entry.text.split("\n").forEach((text, i) => {
      const index = text.indexOf(query);
      if (index < 0) return;
      if (total >= offset && hits.length < 100) hits.push({ path, line: i + 1, excerpt: text.slice(Math.max(0, index - 100), index + query.length + 100) });
      total++;
    });
  }
  return { hits, total, nextOffset: offset + hits.length < total ? offset + hits.length : null, note: "Literal search of supported UTF-8 text only; excerpts, not complete lines" };
}
