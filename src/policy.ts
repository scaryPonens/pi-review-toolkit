import { parseDocument } from "yaml";
import picomatch from "picomatch";
import { limits } from "./snapshot.js";
import type { Policies, Snapshot } from "./types.js";

export const globOptions = Object.freeze({ dot: true, nocase: false, nonegate: true, noext: true, nobrace: true, posixSlashes: true });
export function patterns(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) throw new Error("applyTo must be a nonempty string");
  return value.split(",").map(s => {
    const p = s.trim();
    if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || /[\\\[\]{}()!\x00-\x1f]/.test(p) || p.split("/").some(x => !x || x === ".." || x === ".")) throw new Error(`Invalid applyTo pattern: ${JSON.stringify(p)}; only literal paths, *, ** and ? are supported`);
    picomatch.makeRe(p, { ...globOptions, strictBrackets: true });
    return p;
  });
}
export function loadPolicies(snapshot: Snapshot): Policies {
  const policies: Policies = { instructions: [], errors: [] };
  let total = 0, discovered = 0, applicability = 0;
  for (const path of Object.keys(snapshot.current).sort()) {
    const global = path === ".agent/reviewer-instructions.md";
    const human = path === "HUMAN.md";
    const specific = path.startsWith(".agent/instructions/") && path.endsWith(".instructions.md");
    const blocked = path === ".agent/instructions" || (path.startsWith(".agent/instructions/") && snapshot.current[path].mode === "120000");
    if (!global && !human && !specific && !blocked) continue;
    try {
      if (++discovered > limits.instructionFiles) throw new Error("more than 128 policy files discovered");
      const file = snapshot.current[path];
      if (file.text === undefined) throw new Error(file.limitation ?? "not readable text");
      total += Buffer.byteLength(file.text);
      if (Buffer.byteLength(file.text) > limits.instruction) throw new Error("exceeds 64 KiB policy file limit");
      if (total > limits.policies) throw new Error("combined policies exceed 256 KiB");
      if (human) { policies.human = { path: "HUMAN.md", content: file.text, hash: file.hash }; continue; }
      if (global) { policies.instructions.push({ path, content: file.text, global: true, appliesTo: [] }); continue; }
      const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(file.text);
      if (!match) throw new Error("missing YAML front matter");
      const doc = parseDocument(match[1], { uniqueKeys: true });
      if (doc.errors.length) throw new Error(doc.errors.map(e => e.message).join("; "));
      const data = doc.toJS({ maxAliasCount: 0 });
      const globs = patterns(data?.applyTo);
      const matches = picomatch(globs, globOptions);
      const appliesTo = snapshot.changes.filter(c => matches(c.path) || (!!c.oldPath && matches(c.oldPath))).flatMap(c => c.oldPath ? [c.oldPath, c.path] : [c.path]);
      applicability += appliesTo.length;
      if (applicability > limits.applicability) throw new Error("instruction applicability exceeds 20000 path associations");
      policies.instructions.push({ path, content: file.text.slice(match[0].length), global: false, appliesTo: [...new Set(appliesTo)].sort() });
    } catch (e) { policies.errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return policies;
}
