import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PullRequest {
  number: number; state: string; url: string;
  baseRefName: string; headRefName: string; baseOid: string; headOid: string;
}
/** Runs `gh` in the repository and returns stdout. Injectable for tests. */
export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export const runGh: GhRunner = async (args, cwd) => (await exec("gh", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 })).stdout;
const isOid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);

async function hasCommit(root: string, oid: string) {
  try { await exec("git", ["--no-optional-locks", "cat-file", "-e", `${oid}^{commit}`], { cwd: root, timeout: 30000 }); return true; }
  catch { return false; }
}
/**
 * Resolve a pull request to the exact base and head commits GitHub reports. Commits, not branch names,
 * are reviewed, so a stacked PR's parent branch (including tool-managed bases such as graphite-base/N)
 * cannot move mid-review. Nothing is fetched: missing commits are an error naming the fetch to run.
 */
export async function resolvePullRequest(root: string, pr: number, gh: GhRunner = runGh): Promise<PullRequest> {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error(`Invalid pull request number ${JSON.stringify(pr)}`);
  let data: Record<string, unknown>;
  try { data = JSON.parse(await gh(["pr", "view", String(pr), "--json", "number,state,url,baseRefName,headRefName,baseRefOid,headRefOid"], root)); }
  catch (e) { throw new Error(`Cannot resolve pull request #${pr} with gh: ${e instanceof Error ? e.message : String(e)}`); }
  const { number, state, url, baseRefName, headRefName, baseRefOid, headRefOid } = data ?? {};
  if (number !== pr || typeof state !== "string" || typeof url !== "string" || typeof baseRefName !== "string" || typeof headRefName !== "string" || !isOid(baseRefOid) || !isOid(headRefOid)) {
    throw new Error(`gh returned an unexpected description of pull request #${pr}`);
  }
  const absent: string[] = [];
  for (const [oid, ref] of [[baseRefOid, baseRefName], [headRefOid, `refs/pull/${pr}/head`]]) if (!await hasCommit(root, oid)) absent.push(ref);
  if (absent.length) throw new Error(`Pull request #${pr} commits are not available locally (no fetch is performed). Run: git fetch origin ${absent.join(" ")}`);
  return { number, state, url, baseRefName, headRefName, baseOid: baseRefOid, headOid: headRefOid };
}
