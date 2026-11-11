import type { GhRunner } from "./pr.js";
import { runGh } from "./pr.js";

export interface StackPullRequest {
  number: number; url: string;
  headRefName: string; headRefOid: string; baseRefName: string; baseRefOid: string;
}
/** How a pull request's base was matched to its parent. */
export type StackLink = "branch" | "commit";
export interface Stack {
  /** Bottom first: the first entry's base is not another open pull request. */
  pullRequests: (StackPullRequest & { parent?: number; link?: StackLink })[];
  /** The branch the bottom pull request merges into, such as main. */
  root: string;
  /** Shape problems found before any review, for the operator to read. */
  notes: string[];
}
const MAX_DEPTH = 50;
const fields = "number,url,headRefName,headRefOid,baseRefName,baseRefOid";

async function json<T>(gh: GhRunner, args: string[], root: string, what: string): Promise<T> {
  try { return JSON.parse(await gh(args, root)) as T; }
  catch (e) { throw new Error(`Cannot ${what} with gh: ${e instanceof Error ? e.message : String(e)}`); }
}
/**
 * Walk down from `top` to the bottom of its stack using one listing of open pull requests. A base
 * matches its parent by branch name, or, for tool-managed bases such as graphite-base/<n> that are no
 * pull request's head, by pointing at exactly one open pull request's head commit.
 */
export async function resolveStack(root: string, top: number, gh: GhRunner = runGh): Promise<Stack> {
  if (!Number.isSafeInteger(top) || top < 1) throw new Error(`Invalid pull request number ${JSON.stringify(top)}`);
  const repository = await json<{ defaultBranchRef?: { name?: string } }>(gh, ["repo", "view", "--json", "defaultBranchRef"], root, "read the default branch");
  const defaultBranch = repository?.defaultBranchRef?.name;
  if (!defaultBranch) throw new Error("gh returned no default branch");
  const open = await json<StackPullRequest[]>(gh, ["pr", "list", "--state", "open", "--limit", "2000", "--json", fields], root, "list open pull requests");
  if (!Array.isArray(open)) throw new Error("gh returned an unexpected pull request listing");
  const byNumber = new Map(open.map(p => [p.number, p])), byHead = new Map<string, StackPullRequest[]>(), byOid = new Map<string, StackPullRequest[]>();
  for (const p of open) {
    byHead.set(p.headRefName, [...byHead.get(p.headRefName) ?? [], p]);
    byOid.set(p.headRefOid, [...byOid.get(p.headRefOid) ?? [], p]);
  }
  const start = byNumber.get(top);
  if (!start) throw new Error(`Pull request #${top} is not open; /review-stack starts from an open pull request`);
  const chain: Stack["pullRequests"] = [], notes: string[] = [];
  let current: StackPullRequest | undefined = start;
  // The default branch ends the walk, even if some fork's pull request has a head branch of the same name.
  while (current) {
    if (chain.some(p => p.number === current!.number)) throw new Error(`Pull request stack loops back to #${current.number}`);
    if (chain.length >= MAX_DEPTH) throw new Error(`Pull request stack is deeper than ${MAX_DEPTH}`);
    const byName = (byHead.get(current.baseRefName) ?? []).filter(p => p.number !== current!.number);
    const byCommit = (byOid.get(current.baseRefOid) ?? []).filter(p => p.number !== current!.number);
    let parent: StackPullRequest | undefined, link: StackLink | undefined;
    if (current.baseRefName === defaultBranch) { /* bottom of the stack */ }
    else if (byName.length === 1) { parent = byName[0]; link = "branch"; }
    else if (byName.length > 1) notes.push(`#${current.number}: base ${current.baseRefName} is the head of several open pull requests (${byName.map(p => `#${p.number}`).join(", ")}); the stack below it is not followed`);
    else if (byCommit.length === 1) { parent = byCommit[0]; link = "commit"; }
    else if (byCommit.length > 1) notes.push(`#${current.number}: base ${current.baseRefName} points at the head of several open pull requests (${byCommit.map(p => `#${p.number}`).join(", ")}); the stack below it is not followed`);
    chain.unshift({ ...current, ...(parent ? { parent: parent.number, link } : {}) });
    current = parent;
  }
  const bottom = chain[0];
  if (bottom.baseRefName !== defaultBranch) {
    // The bottom pull request is not on the default branch: its parent may be closed or merged.
    const below = await json<{ number: number; state: string }[]>(gh, ["pr", "list", "--state", "all", "--head", bottom.baseRefName, "--limit", "5", "--json", "number,state"], root, `look up pull requests for ${bottom.baseRefName}`);
    const closed = (Array.isArray(below) ? below : []).filter(p => p.state !== "OPEN");
    notes.push(closed.length
      ? `#${bottom.number}: its base ${bottom.baseRefName} is the head of ${closed.map(p => `${p.state.toLowerCase()} pull request #${p.number}`).join(", ")}; retarget it before merging`
      : `#${bottom.number}: its base ${bottom.baseRefName} is neither ${defaultBranch} nor an open pull request's branch or head commit`);
  }
  for (const p of chain) {
    if (p.link === "commit") notes.push(`#${p.number}: base ${p.baseRefName} is not a pull request branch; it points at #${p.parent}'s head commit, so #${p.parent} is treated as its parent`);
    // Open pull requests stacked on this one that the walk did not include.
    const above = open.filter(o => (o.baseRefName === p.headRefName || (o.baseRefOid === p.headRefOid && !byHead.has(o.baseRefName))) && !chain.some(c => c.number === o.number));
    if (above.length) notes.push(`#${p.number} also has ${above.map(o => `#${o.number}`).join(", ")} stacked on it, not reviewed here`);
  }
  return { pullRequests: chain, root: bottom.baseRefName, notes };
}
