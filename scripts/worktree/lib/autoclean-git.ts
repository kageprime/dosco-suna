/**
 * Pure git-side rules for `autoclean`: which `git worktree list` entries are
 * Claude Code isolation worktrees, whether their agent still runs, whether a
 * branch is merged, and which leftover `worktree-agent-*` branches to delete.
 * The probes (git, gh, /proc) live in cli.ts.
 */

export interface GitWorktree {
  path: string;
  head?: string;
  /** short branch name; undefined when detached. */
  branch?: string;
  /** `git worktree lock` reason; '' when locked with no reason; undefined when not locked. */
  locked?: string;
  prunable?: boolean;
  bare?: boolean;
}

/** `git worktree list --porcelain` → entries. */
export function parseWorktreePorcelain(stdout: string): GitWorktree[] {
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; out.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'locked') cur.locked = '';
    else if (line.startsWith('locked ')) cur.locked = line.slice(7);
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
    else if (line === 'bare') cur.bare = true;
  }
  return out;
}

/** Claude Code creates its isolation worktrees under `<primary>/.claude/worktrees/<id>`. */
export function isClaudeWorktree(path: string, primary: string): boolean {
  const base = `${primary.replace(/\/+$/, '')}/.claude/worktrees/`;
  return path.startsWith(base) && path.length > base.length && !path.slice(base.length).includes('/');
}

/** Claude Code's lock reason: `claude agent <id> (pid <pid> start <ticks>)`. Null for any other reason. */
export function parseClaudeLock(reason: string | undefined): { pid: number; start: string } | null {
  if (reason === undefined) return null;
  const m = /^claude agent \S+ \(pid (\d+) start (\d+)\)$/.exec(reason.trim());
  return m ? { pid: Number(m[1]), start: m[2]! } : null;
}

export type LockState = 'none' | 'agent-running' | 'agent-gone' | 'other';

/**
 * What a worktree lock means. `procStart(pid)` returns the process start time
 * in the same unit Claude Code records (Linux: /proc/<pid>/stat field 22),
 * `undefined` when the process is alive but its start time is unknowable
 * (macOS), or null when no such process exists. A live pid whose start time
 * differs is a reused pid: the agent is gone. A lock with any other reason
 * was set by a person and is honored.
 */
export function lockState(reason: string | undefined, procStart: (pid: number) => string | null | undefined): LockState {
  if (reason === undefined) return 'none';
  const lock = parseClaudeLock(reason);
  if (!lock) return 'other';
  const start = procStart(lock.pid);
  if (start === null) return 'agent-gone';
  if (start === undefined) return 'agent-running';
  return start === lock.start ? 'agent-running' : 'agent-gone';
}

/** Linux `/proc/<pid>/stat` text → start time (field 22), or null. The comm field may hold spaces and parens. */
export function procStatStart(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // Fields after comm start at field 3 (state); starttime is field 22 → index 19.
  const rest = stat.slice(close + 2).trim().split(/\s+/);
  return rest[19] ?? null;
}

export interface MergedPr { number: number; headRefName: string; headRefOid: string }

/** `gh pr list --state merged --json number,headRefName,headRefOid` → head branch → PRs. */
export function mergedPrIndex(json: string): Map<string, MergedPr[]> {
  const idx = new Map<string, MergedPr[]>();
  let rows: unknown;
  try { rows = JSON.parse(json); } catch { return idx; }
  if (!Array.isArray(rows)) return idx;
  for (const r of rows as Array<Partial<MergedPr>>) {
    if (typeof r?.headRefName !== 'string' || typeof r.headRefOid !== 'string' || typeof r.number !== 'number') continue;
    const list = idx.get(r.headRefName) ?? [];
    list.push({ number: r.number, headRefName: r.headRefName, headRefOid: r.headRefOid });
    idx.set(r.headRefName, list);
  }
  return idx;
}

/**
 * The merged PR that covers `tip`, or null. A PR covers the tip when its head
 * commit is the tip, or when every commit on the tip that is not in the PR's
 * head is on a remote (`beyond(oid)` returns that count, or null when the oid
 * is not in the local repo). A branch name reused for new work after its old
 * PR merged is therefore not "merged".
 */
export function prCovering(prs: MergedPr[] | undefined, tip: string, beyond: (oid: string) => number | null): MergedPr | null {
  for (const pr of prs ?? []) {
    if (pr.headRefOid === tip) return pr;
    if (beyond(pr.headRefOid) === 0) return pr;
  }
  return null;
}

export interface BranchCandidate {
  name: string;
  /** a worktree has it checked out. */
  checkedOut: boolean;
  /** commits that no remote ref contains; null when unknown. */
  unpushed: number | null;
  merged: boolean;
}

/** Leftover branches Claude Code isolation worktrees create. */
export const AGENT_BRANCH = /^worktree-agent-[0-9a-z]+$/;

/**
 * A `worktree-agent-*` branch with no worktree is deleted when it holds no
 * commit that exists only here: every commit is on a remote, or its work is
 * merged into dev. Any other branch name is never touched here.
 */
export function decideBranch(b: BranchCandidate): { name: string; remove: boolean; why: string } {
  if (!AGENT_BRANCH.test(b.name)) return { name: b.name, remove: false, why: 'not a worktree-agent-* branch' };
  if (b.checkedOut) return { name: b.name, remove: false, why: 'checked out in a worktree' };
  if (b.merged) return { name: b.name, remove: true, why: 'merged into dev' };
  if (b.unpushed === null) return { name: b.name, remove: false, why: 'push state unknown' };
  if (b.unpushed > 0) return { name: b.name, remove: false, why: `${b.unpushed} commit(s) on no remote` };
  return { name: b.name, remove: true, why: 'every commit on a remote' };
}
