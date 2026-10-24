import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
export type CommandRunner = (binary: string, args: string[]) => Promise<string>;
export const command: CommandRunner = async (binary, args) => (await exec(binary, args, { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout;
export const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
function parseBackend<T = unknown>(text: string): T {
  try { return JSON.parse(text) as T; }
  catch (e) { throw new Error(`Malformed backend response: ${e instanceof Error ? e.message : String(e)}`); }
}
interface HerdrResponse {
  result?: {
    layout?: { workspace_id?: string; panes?: { pane_id: string; rect: { width: number; height: number } }[] };
    pane?: { pane_id?: string };
  };
}
export interface Backend {
  name: string;
  start(command: string, cwd: string, signal?: AbortSignal): Promise<string>;
  close(id: string): Promise<void>;
  cleanup(): Promise<string[]>;
}
export async function chooseBackend(run: CommandRunner = command, env = process.env): Promise<Backend> {
  if (env.HERDR_ENV === "1" && env.HERDR_PANE_ID) {
    // Do not downgrade after selecting an appropriate Herdr environment.
    const version = await run("herdr", ["--version"]);
    if (!/herdr 0\.8\./.test(version)) throw new Error(`Unsupported Herdr version: ${version.trim()}; tested 0.8.x`);
    return new HerdrBackend(env.HERDR_PANE_ID, run, env.HERDR_WORKSPACE_ID);
  }
  try {
    const version = await run("tmux", ["-V"]);
    if (!/^tmux (?:3\.[2-9]|[4-9]\.)/.test(version.trim())) throw new Error("tmux >=3.2 is required");
    return new TmuxBackend(run);
  } catch (e) { throw new Error(`No supported execution backend. Use Herdr 0.8.x inside a managed pane, or install tmux >=3.2. ${e instanceof Error ? e.message : String(e)}`); }
}
abstract class OwnedBackend implements Backend {
  abstract name: string;
  readonly owned = new Set<string>();
  private closing = new Map<string, Promise<void>>();
  constructor(protected run: CommandRunner) {}
  abstract start(command: string, cwd: string, signal?: AbortSignal): Promise<string>;
  abstract destroy(id: string): Promise<void>;
  async close(id: string): Promise<void> {
    if (!this.owned.has(id)) return;
    const pending = this.closing.get(id);
    if (pending) return pending;
    const action = this.destroy(id).then(() => { this.owned.delete(id); }).finally(() => this.closing.delete(id));
    this.closing.set(id, action);
    return action;
  }
  async cleanup() {
    const errors: string[] = [];
    await Promise.all([...this.owned].map(async id => {
      try { await this.close(id); } catch (e) { errors.push(`Cleanup of owned pane ${id} failed: ${e instanceof Error ? e.message : String(e)}`); }
      return undefined;
    }));
    return errors;
  }
}
export class HerdrBackend extends OwnedBackend {
  name = "herdr";
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private caller: string, run: CommandRunner = command, private workspace?: string) { super(run); }
  async start(shell: string, cwd: string, signal?: AbortSignal): Promise<string> {
    // Serialize layout mutations only; worker inference runs concurrently.
    const operation = this.serial.then(async () => {
      signal?.throwIfAborted();
      const layout = parseBackend<HerdrResponse>(await this.run("herdr", ["pane", "layout", "--pane", this.caller]));
      this.workspace = layout.result?.layout?.workspace_id ?? this.workspace;
      const candidates = layout.result?.layout?.panes?.filter((p: { pane_id: string }) => p.pane_id === this.caller || this.owned.has(p.pane_id));
      if (!Array.isArray(candidates) || !candidates.length) throw new Error("Herdr caller pane is unavailable");
      candidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
      const target = candidates[0];
      const direction = target.rect.width > target.rect.height * 2 ? "right" : "down";
      const response = parseBackend<HerdrResponse>(await this.run("herdr", ["pane", "split", "--pane", target.pane_id, "--direction", direction, "--cwd", cwd, "--no-focus"]));
      const id: unknown = response.result?.pane?.pane_id;
      if (typeof id !== "string" || !id || id.length > 128 || /[\x00-\x1f\x7f]/.test(id) || id === this.caller || this.owned.has(id)) throw new Error("Invalid/duplicate Herdr pane ID in creation response");
      this.owned.add(id);
      signal?.throwIfAborted();
      await this.run("herdr", ["pane", "run", id, shell]);
      return id;
    });
    this.serial = operation.catch(() => {});
    return operation;
  }
  async destroy(id: string) {
    try { await this.run("herdr", ["pane", "close", id]); }
    catch (e) {
      // An already closed owned pane is clean; verify absence rather than suppressing errors.
      if (!this.workspace) throw new Error("Cannot verify cleanup without a returned Herdr workspace identity");
      const listing = parseBackend<{ result?: { panes?: { pane_id: string }[] } }>(await this.run("herdr", ["pane", "list", "--workspace", this.workspace]));
      const panes = listing.result?.panes;
      if (!Array.isArray(panes)) throw new Error("Cannot verify owned pane absence after cleanup failure");
      if (panes.some(p => p.pane_id === id)) throw e;
    }
  }
}
export class TmuxBackend extends OwnedBackend {
  name = "tmux";
  async start(shell: string, cwd: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const id = (await this.run("tmux", ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", `pi-review-${randomUUID()}`, "-c", cwd, "/bin/sh", "-c", shell])).trim();
    if (!/^%\d+$/.test(id) || this.owned.has(id)) throw new Error("Invalid/duplicate tmux pane ID in creation response");
    this.owned.add(id);
    return id;
  }
  async destroy(id: string) {
    try { await this.run("tmux", ["kill-pane", "-t", id]); }
    catch (e) {
      try {
        const panes = await this.run("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
        if (panes.trim().split("\n").includes(id)) throw e;
      } catch (probe) {
        if (!/no server running|no sessions/i.test(String(probe))) throw probe;
      }
    }
  }
}
