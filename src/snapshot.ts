import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Entry, Snapshot, Change } from "./types.js";

const exec = promisify(execFile);
export const limits = { file: 1024 * 1024, total: 64 * 1024 * 1024, files: 20000, diff: 8 * 1024 * 1024, instruction: 64 * 1024, policies: 256 * 1024, instructionFiles: 128, applicability: 20000 };
export const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function validPath(path: string): boolean {
  return !!path && !path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path) && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && path.split("/").every(p => p !== ".." && p !== "." && !!p) && !path.split("/").includes(".git");
}
async function git(cwd: string, args: string[]): Promise<Buffer> {
  return (await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { cwd, encoding: "buffer", maxBuffer: 80 * 1024 * 1024, timeout: 30000 })).stdout;
}
const textGit = async (cwd: string, args: string[]) => (await git(cwd, args)).toString("utf8").trim();
export async function rootOf(cwd: string) { return realpath(await textGit(cwd, ["rev-parse", "--show-toplevel"])); }
export async function selectBase(root: string, supplied?: string): Promise<string> {
  if (supplied) {
    if (supplied.startsWith("-") || /[\x00-\x20]/.test(supplied)) throw new Error("Invalid --base ref");
    await textGit(root, ["rev-parse", "--verify", `${supplied}^{commit}`]);
    return supplied;
  }
  const remotes = (await textGit(root, ["remote"])).split("\n").filter(Boolean);
  const defaults = new Set<string>();
  for (const remote of remotes) {
    try { defaults.add(await textGit(root, ["symbolic-ref", `refs/remotes/${remote}/HEAD`])); } catch { /* A remote without a local HEAD is not a known default. */ }
  }
  if (defaults.size === 1) return [...defaults][0];
  throw new Error("No unambiguous locally known default target. Run /review --base <git-ref> (no fetch is performed).");
}
async function hashLargeBlob(root: string, oid: string): Promise<string> {
  const child = spawn("git", ["--no-optional-locks", "cat-file", "blob", oid], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Cannot hash base blob (${code})`)));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
  const digest = createHash("sha256");
  try {
    await Promise.all([completion, (async () => { for await (const chunk of child.stdout!) digest.update(chunk); })()]);
    return digest.digest("hex");
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); }
}
function entry(data: Buffer, mode: string): Entry {
  const digest = hash(data);
  if (mode === "120000") return { hash: digest, mode, limitation: "symlinks are not followed" };
  if (data.length > limits.file) return { hash: digest, mode, limitation: "file exceeds 1 MiB" };
  if (data.includes(0)) return { hash: digest, mode, limitation: "binary content" };
  const text = data.toString("utf8");
  if (!Buffer.from(text).equals(data)) return { hash: digest, mode, limitation: "non-UTF-8 content" };
  if (text.startsWith("version https://git-lfs.github.com/spec/v1\n")) return { hash: digest, mode, limitation: "Git LFS pointer (not hydrated)" };
  return { hash: digest, mode, text };
}
async function baseFiles(root: string, commit: string, signal?: AbortSignal): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = Object.create(null);
  const rows = (await git(root, ["ls-tree", "-rz", "--full-tree", commit])).toString("utf8").split("\0").filter(Boolean);
  if (rows.length > limits.files) throw new Error("Repository exceeds 20000 files");
  let total = 0;
  for (const row of rows) {
    signal?.throwIfAborted();
    const tab = row.indexOf("\t"), path = row.slice(tab + 1);
    if (!validPath(path)) throw new Error(`Unsupported repository path: ${JSON.stringify(path)}`);
    const [mode, kind, oid] = row.slice(0, tab).split(" ");
    if (kind === "commit") { out[path] = { hash: oid, mode, limitation: "submodule content is unsupported" }; continue; }
    const size = Number(await textGit(root, ["cat-file", "-s", oid]));
    total += size;
    if (total > limits.total) throw new Error("Base repository content exceeds 64 MiB capture limit");
    if (size > limits.file) { out[path] = { hash: await hashLargeBlob(root, oid), mode, limitation: "file exceeds 1 MiB" }; continue; }
    const data = await git(root, ["cat-file", "blob", oid]);
    out[path] = entry(data, mode);
  }
  return out;
}
async function policyPaths(root: string): Promise<string[]> {
  const out = ["HUMAN.md", ".agent/reviewer-instructions.md"];
  async function walk(dir: string) {
    try {
      const stat = await lstat(join(root, dir));
      if (!stat.isDirectory() || stat.isSymbolicLink()) { out.push(dir); return; }
      for (const d of await readdir(join(root, dir), { withFileTypes: true })) {
        const path = `${dir}/${d.name}`;
        if (d.isDirectory()) await walk(path);
        else if (path.endsWith(".instructions.md") || d.isSymbolicLink()) out.push(path);
        if (out.length > limits.files) throw new Error("Too many instruction paths");
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  await walk(".agent/instructions");
  return out;
}
async function currentFiles(root: string, signal?: AbortSignal): Promise<{ entries: Record<string, Entry>; scopePaths: string[] }> {
  const listed = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).toString("utf8").split("\0").filter(Boolean);
  const staged = (await git(root, ["ls-files", "--stage", "-z"])).toString("utf8").split("\0");
  const gitlinks = new Map<string, string>();
  for (const row of staged) {
    const tab = row.indexOf("\t"), fields = row.slice(0, tab).split(" ");
    if (fields[0] === "160000") gitlinks.set(row.slice(tab + 1), fields[1]);
  }
  const paths = [...new Set([...listed, ...await policyPaths(root)])].sort();
  if (paths.length > limits.files) throw new Error("Repository exceeds 20000 files");
  const out: Record<string, Entry> = Object.create(null);
  let total = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    if (!validPath(path)) throw new Error(`Unsupported repository path: ${JSON.stringify(path)}`);
    const full = join(root, path);
    try {
      // Reject intermediate symlinks too: a tracked directory may have been replaced.
      let parent = root;
      for (const part of path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if ((await lstat(parent)).isSymbolicLink()) throw new Error(`Symlink directory blocks capture: ${path}`);
      }
      const st = await lstat(full);
      if (st.isSymbolicLink()) { out[path] = entry(Buffer.from(await readlink(full)), "120000"); continue; }
      if (st.isDirectory() && gitlinks.has(path)) {
        let oid = gitlinks.get(path)!;
        const subRoot = await realpath(await textGit(full, ["rev-parse", "--show-toplevel"]));
        if (subRoot === await realpath(full)) {
          oid = await textGit(full, ["rev-parse", "HEAD"]);
          if ((await git(full, ["status", "--porcelain=v1", "--untracked-files=normal", "--ignore-submodules=none"])).length) oid += ":dirty";
        }
        out[path] = { hash: oid, mode: "160000", limitation: "submodule content is unsupported" };
        continue;
      }
      if (!st.isFile()) { out[path] = { hash: "unsupported-directory", mode: "160000", limitation: "directories/special files are unsupported" }; continue; }
      const resolved = await realpath(full);
      if (relative(root, resolved).startsWith(`..${sep}`)) throw new Error(`Path escaped root: ${path}`);
      const mode = st.mode & 0o111 ? "100755" : "100644";
      total += st.size;
      if (total > limits.total) throw new Error("Working repository content exceeds 64 MiB capture limit");
      if (st.size > limits.file) {
        const h = createHash("sha256");
        for await (const chunk of createReadStream(full)) h.update(chunk);
        out[path] = { hash: h.digest("hex"), mode, limitation: "file exceeds 1 MiB" };
      } else {
        const data = await readFile(full);
        if (data.length > st.size) total += data.length - st.size;
        if (total > limits.total) throw new Error("Working repository content grew beyond 64 MiB capture limit");
        out[path] = entry(data, mode);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  return { entries: out, scopePaths: [...new Set(listed)].sort() };
}
async function fingerprint(root: string) {
  if ((await git(root, ["ls-files", "-u", "-z"])).length) throw new Error("Unresolved merge conflicts; resolve them before /review");
  return hash(Buffer.concat([await git(root, ["rev-parse", "HEAD"]), await git(root, ["ls-files", "--stage", "-z"])]));
}
export function makeChanges(old: Record<string, Entry>, current: Record<string, Entry>): Change[] {
  const changes: Change[] = [];
  for (const path of [...new Set([...Object.keys(old), ...Object.keys(current)])].sort()) {
    if (!old[path]) changes.push({ path, status: "added" });
    else if (!current[path]) changes.push({ path, status: "deleted" });
    else if (old[path].hash !== current[path].hash || old[path].mode !== current[path].mode) changes.push({ path, status: "modified" });
  }
  // Exact-content renames only; uncertain renames remain an addition + deletion.
  for (const added of changes.filter(c => c.status === "added")) {
    const deleted = changes.find(c => c.status === "deleted" && old[c.path].hash === current[added.path].hash && old[c.path].mode === current[added.path].mode);
    if (deleted) { added.status = "renamed"; added.oldPath = deleted.path; changes.splice(changes.indexOf(deleted), 1); }
  }
  return changes;
}
export async function capture(root: string, baseRef: string, signal?: AbortSignal): Promise<Snapshot> {
  root = await realpath(root);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const before = await fingerprint(root);
    const head = await textGit(root, ["rev-parse", "HEAD"]);
    const baseCommit = await textGit(root, ["merge-base", baseRef, head]);
    const old = await baseFiles(root, baseCommit, signal);
    const captured = await currentFiles(root, signal);
    const current = captured.entries;
    const verify = await currentFiles(root, signal);
    if (before !== await fingerprint(root) || hash(JSON.stringify(captured)) !== hash(JSON.stringify(verify)) || baseCommit !== await textGit(root, ["merge-base", baseRef, "HEAD"])) continue;
    signal?.throwIfAborted();
    const changes = makeChanges(old, Object.fromEntries(captured.scopePaths.filter(path => current[path]).map(path => [path, current[path]]))), limitations: string[] = [];
    let diff = "";
    for (const c of changes) {
      const a = old[c.oldPath ?? c.path], b = current[c.path];
      for (const [side, file] of [["old", a], ["new", b]] as const) if (file?.limitation) limitations.push(`${c.path} (${side}): ${file.limitation}`);
      diff += `Change: ${c.status} ${JSON.stringify(c.oldPath ?? c.path)} -> ${JSON.stringify(c.path)}; mode ${a?.mode ?? "absent"} -> ${b?.mode ?? "absent"}\n`;
      signal?.throwIfAborted();
      if (a?.text !== undefined || b?.text !== undefined) {
        const patch = createTwoFilesPatch(c.oldPath ?? c.path, c.path, a?.text ?? "", b?.text ?? "", "base", "snapshot", { context: 5, timeout: 5000 });
        if (patch === undefined) throw new Error(`Diff computation exceeded 5 seconds for ${c.path}`);
        diff += patch;
      }
      if (Buffer.byteLength(diff) > limits.diff) throw new Error("Review diff exceeds 8 MiB; narrow the branch changes");
    }
    const id = hash(JSON.stringify({ baseRef, baseCommit, head, old, current, changes }));
    return { id, baseRef, baseCommit, head, old, current, changes, diff, limitations };
  }
  throw new Error("Working tree, index, HEAD, or base changed during capture (3 attempts); retry when edits settle");
}
