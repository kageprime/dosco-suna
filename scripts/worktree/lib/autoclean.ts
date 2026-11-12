/**
 * `autoclean`: automatic disk housekeeping for registered worktrees.
 *
 * Pure rules only. The probes (ports, processes, `git status`, `df`, crontab)
 * live in cli.ts and feed one AutocleanCandidate per registry slot.
 *
 * Measured on 2026-11-10 on a 98 GB /work volume that hit 100%: a worktree
 * holds ~1.3 GB of unshared files (node_modules is 5.6 GB but mostly hardlinks
 * into the pnpm store) plus `apps/web/.next`, which grows without bound under
 * `next dev` (3.4 GB and 7.0 GB in two checkouts).
 */
import { parseDuration } from './prune';

/**
 * Tracked files a running dev server rewrites. A change to one of these alone
 * does not make a checkout dirty, and its mtime is not activity.
 */
export const NOISE_PATHS: readonly string[] = ['apps/web/src/lib/seo/content-timestamps.json'];

export const DEFAULT_SWEEP_IDLE = '24h';
export const DEFAULT_REMOVE_IDLE = '48h';
/** A worktree whose branch is merged into dev is removed sooner: its work is safe in dev. */
export const DEFAULT_MERGED_REMOVE_IDLE = '24h';
/** Under disk pressure every clean, pushed or merged worktree idle this long is removed. */
export const DEFAULT_PRESSURE_REMOVE_IDLE = '12h';
/**
 * Build output dirs larger than this are deleted in any checkout whose stack is
 * not running, however recently it was used. `next dev` grows `.next` without
 * bound (5.7 GB and 7.0 GB in two active checkouts on 2026-11-10), and an
 * active checkout is never idle, so the idle rules alone never shrink it.
 */
export const DEFAULT_CAP_GB = 3;
/** Free space below this turns on pressure mode. */
export const DEFAULT_PRESSURE_GB = 15;
/** A build output dir written within this many minutes is in use: never deleted. */
export const RECENT_WRITE_MIN = 10;

/** Free space below this on `create`/`start`: warn and name the largest checkouts. */
export const DISK_WARN_BYTES = 10 * 1024 ** 3;
/** Free space below this: `create` refuses with exit 2. */
export const DISK_REFUSE_BYTES = 4 * 1024 ** 3;

/** The idle thresholds one autoclean pass applies. */
export interface AutocleanThresholds {
  sweepIdleMs: number;
  removeIdleMs: number;
  /** remove threshold for a worktree whose branch is merged; defaults to removeIdleMs. */
  mergedRemoveIdleMs?: number;
}

export interface AutocleanConfig extends AutocleanThresholds {
  enabled: boolean;
  mergedRemoveIdleMs: number;
  pressureRemoveIdleMs: number;
  /** build output dir size cap, bytes. */
  capBytes: number;
  /** free space below this is disk pressure, bytes. */
  pressureFreeBytes: number;
}

/**
 * KORTIX_WORKTREE_AUTOCLEAN=0 (or false/off/no) turns the automatic run off.
 * KORTIX_WORKTREE_SWEEP_IDLE / KORTIX_WORKTREE_REMOVE_IDLE take `<n>m|h|d|w`.
 * KORTIX_WORKTREE_MERGED_REMOVE_IDLE / KORTIX_WORKTREE_PRESSURE_REMOVE_IDLE too.
 * KORTIX_WORKTREE_NEXT_CAP_GB (build output cap) and KORTIX_WORKTREE_PRESSURE_GB
 * (pressure mode below this free space) take a number of GB.
 * An invalid value falls back to the default and returns a warning: a typo
 * in an env var must not break `create`.
 */
export function autocleanConfig(env: Record<string, string | undefined>): { config: AutocleanConfig; warnings: string[] } {
  const warnings: string[] = [];
  const dur = (key: string, fallback: string): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return parseDuration(fallback);
    try { return parseDuration(raw); } catch {
      warnings.push(`${key}="${raw}" is not <n>m|h|d|w — using ${fallback}`);
      return parseDuration(fallback);
    }
  };
  const gb = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback * 1024 ** 3;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 1024 ** 3;
    warnings.push(`${key}="${raw}" is not a positive number of GB — using ${fallback}`);
    return fallback * 1024 ** 3;
  };
  const off = /^(0|false|off|no)$/i.test((env.KORTIX_WORKTREE_AUTOCLEAN ?? '').trim());
  return {
    config: {
      enabled: !off,
      sweepIdleMs: dur('KORTIX_WORKTREE_SWEEP_IDLE', DEFAULT_SWEEP_IDLE),
      removeIdleMs: dur('KORTIX_WORKTREE_REMOVE_IDLE', DEFAULT_REMOVE_IDLE),
      mergedRemoveIdleMs: dur('KORTIX_WORKTREE_MERGED_REMOVE_IDLE', DEFAULT_MERGED_REMOVE_IDLE),
      pressureRemoveIdleMs: dur('KORTIX_WORKTREE_PRESSURE_REMOVE_IDLE', DEFAULT_PRESSURE_REMOVE_IDLE),
      capBytes: gb('KORTIX_WORKTREE_NEXT_CAP_GB', DEFAULT_CAP_GB),
      pressureFreeBytes: gb('KORTIX_WORKTREE_PRESSURE_GB', DEFAULT_PRESSURE_GB),
    },
    warnings,
  };
}

export interface AutocleanPass extends Required<AutocleanThresholds> {
  /** free space is below the pressure threshold. */
  pressure: boolean;
}

/**
 * The thresholds for one pass. Normal: the config. Pressure (free space known
 * and below `pressureFreeBytes`): build output is swept in every checkout that
 * is not running, whatever its idle time, and removal drops to
 * `pressureRemoveIdleMs`. A threshold never rises above the configured one.
 */
export function autocleanPass(cfg: AutocleanConfig, freeBytes: number | null): AutocleanPass {
  const merged = Math.min(cfg.mergedRemoveIdleMs, cfg.removeIdleMs);
  const pressure = freeBytes !== null && freeBytes < cfg.pressureFreeBytes;
  if (!pressure) return { pressure, sweepIdleMs: cfg.sweepIdleMs, removeIdleMs: cfg.removeIdleMs, mergedRemoveIdleMs: merged };
  const remove = Math.min(cfg.pressureRemoveIdleMs, cfg.removeIdleMs);
  return { pressure, sweepIdleMs: 0, removeIdleMs: remove, mergedRemoveIdleMs: Math.min(remove, merged) };
}

export interface StatusEntry { xy: string; path: string }

/**
 * `git status --porcelain` (v1) → entries. A rename `R  old -> new` yields the
 * new path. Quoted paths (`"a b"`) are unquoted; C escapes are left as written.
 */
export function parsePorcelain(stdout: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0 && (xy[0] === 'R' || xy[0] === 'C')) path = path.slice(arrow + 4);
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    out.push({ xy, path: path.replace(/\/$/, '') });
  }
  return out;
}

export function isNoise(path: string, noise: readonly string[] = NOISE_PATHS): boolean {
  return noise.includes(path);
}

/** The status entries that are real work: everything except NOISE_PATHS. */
export function meaningfulChanges(entries: StatusEntry[], noise: readonly string[] = NOISE_PATHS): StatusEntry[] {
  return entries.filter((e) => !isNoise(e.path, noise));
}

/**
 * Last activity of a checkout, in epoch ms: the newest of registry createdAt,
 * registry lastUsedAt (create/start/web/stop), the HEAD commit time, and the
 * mtime of each changed non-noise file. A read (`git status`, `ls`, an editor
 * opening a file) changes none of these. The worktree index mtime is not used:
 * a read-only `git status` refreshes it. Null when nothing is known.
 */
export function lastActivity(input: {
  createdAt?: string;
  lastUsedAt?: string;
  headCommitMs?: number | null;
  changedMtimesMs?: number[];
}): number | null {
  const xs = [
    input.createdAt ? Date.parse(input.createdAt) : NaN,
    input.lastUsedAt ? Date.parse(input.lastUsedAt) : NaN,
    input.headCommitMs ?? NaN,
    ...(input.changedMtimesMs ?? []),
  ].filter((x) => Number.isFinite(x) && x > 0);
  return xs.length ? Math.max(...xs) : null;
}

export interface AutocleanCandidate {
  name: string;
  /** the primary checkout is never touched. */
  primary: boolean;
  /** web or api port answering. */
  live: boolean;
  /** a process runs inside the checkout or names it on its command line. */
  busy: boolean;
  /** registry slot whose directory is gone. */
  missing: boolean;
  /** the directory exists but `git worktree list` does not name it: not ours to touch. */
  unregistered?: boolean;
  /** changed tracked + untracked files that are not NOISE_PATHS. */
  meaningfulChanges: number;
  /** commits on HEAD/the branch that no remote ref contains; null when unknown. */
  unpushed: number | null;
  /**
   * the branch's work is in dev: its PR is merged (same tip), or merging it
   * into origin/dev changes nothing. Counts as pushed, and lowers the remove
   * threshold to mergedRemoveIdleMs.
   */
  merged?: boolean;
  /** epoch ms, from `lastActivity`; null when unknown. */
  lastActivity: number | null;
  /** the worktree the current command operates on; never removed. */
  current?: boolean;
}

export interface AutocleanVerdict {
  name: string;
  sweep: boolean;
  remove: boolean;
  why: string;
}

const fmtAge = (ms: number) =>
  ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 86_400_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.round(ms / 86_400_000)}d`;

/**
 * Precedence: primary, live and busy checkouts are never touched. A missing
 * directory frees its slot once the slot is idle ≥ removeIdle (a younger slot
 * may be another session's `create` between the registry write and
 * `git worktree add`). Unknown activity touches nothing. Otherwise build
 * output is swept at ≥ sweepIdle, and the whole worktree is removed at
 * ≥ removeIdle when it has no real changes and every commit is on a remote.
 */
export function decideAutoclean(c: AutocleanCandidate, cfg: AutocleanThresholds, nowMs: number): AutocleanVerdict {
  const keep = (why: string): AutocleanVerdict => ({ name: c.name, sweep: false, remove: false, why });
  if (c.primary) return keep('primary checkout');
  if (c.live) return keep('stack is running');
  if (c.busy) return keep('a process uses the checkout');
  if (c.unregistered && !c.missing) return keep('not a git worktree of this repo (see pnpm worktree doctor)');
  if (c.lastActivity === null) return keep('unknown activity');
  const idle = nowMs - c.lastActivity;
  const age = `idle ${fmtAge(idle)}`;
  if (c.missing) {
    return idle >= cfg.removeIdleMs
      ? { name: c.name, sweep: false, remove: true, why: `directory missing, ${age} — freeing slot` }
      : keep(`directory missing, ${age} (< ${fmtAge(cfg.removeIdleMs)})`);
  }
  const sweep = idle >= cfg.sweepIdleMs;
  const removeAt = c.merged ? Math.min(cfg.mergedRemoveIdleMs ?? cfg.removeIdleMs, cfg.removeIdleMs) : cfg.removeIdleMs;
  if (idle < removeAt) return { name: c.name, sweep, remove: false, why: sweep ? `${age} — sweep build output` : `${age} (< ${fmtAge(cfg.sweepIdleMs)})` };
  if (c.current) return { name: c.name, sweep, remove: false, why: `${age} — current worktree, kept` };
  if (c.meaningfulChanges > 0) return { name: c.name, sweep, remove: false, why: `${age} — ${c.meaningfulChanges} uncommitted change(s), kept` };
  if (!c.merged && c.unpushed === null) return { name: c.name, sweep, remove: false, why: `${age} — push state unknown, kept` };
  if (!c.merged && c.unpushed! > 0) return { name: c.name, sweep, remove: false, why: `${age} — ${c.unpushed} commit(s) on no remote, kept` };
  return { name: c.name, sweep: false, remove: true, why: `${age}, clean, ${c.merged ? 'merged into dev' : 'every commit on a remote'} — remove` };
}

export type DiskLevel = 'ok' | 'warn' | 'refuse';

export function diskLevel(freeBytes: number, warnBytes = DISK_WARN_BYTES, refuseBytes = DISK_REFUSE_BYTES): DiskLevel {
  if (freeBytes < refuseBytes) return 'refuse';
  if (freeBytes < warnBytes) return 'warn';
  return 'ok';
}

/** `df -Pk <dir>` → free bytes on that filesystem, or null when unparseable. */
export function parseDfFreeBytes(stdout: string): number | null {
  const lines = stdout.trim().split('\n');
  if (lines.length < 2) return null;
  // POSIX output: Filesystem 1024-blocks Used Available Capacity Mounted-on.
  // A long device name never wraps under -P, but may hold spaces: read from the right.
  const cols = lines[lines.length - 1]!.trim().split(/\s+/);
  if (cols.length < 6) return null;
  const avail = Number(cols[cols.length - 3]);
  return Number.isFinite(avail) ? avail * 1024 : null;
}

/**
 * Disk-guard thresholds in bytes. KORTIX_WORKTREE_DISK_WARN_GB and
 * KORTIX_WORKTREE_DISK_REFUSE_GB override the 10 / 4 GB defaults; a value that
 * is not a non-negative number is ignored. Refuse never exceeds warn.
 */
export function diskThresholds(env: Record<string, string | undefined>): { warnBytes: number; refuseBytes: number } {
  const gb = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n * 1024 ** 3 : fallback;
  };
  const warnBytes = gb(env.KORTIX_WORKTREE_DISK_WARN_GB, DISK_WARN_BYTES);
  return { warnBytes, refuseBytes: Math.min(warnBytes, gb(env.KORTIX_WORKTREE_DISK_REFUSE_GB, DISK_REFUSE_BYTES)) };
}

/** 7340032 → "7.0 GB"; under 1 GB in MB. */
export function fmtKb(kb: number): string {
  return kb >= 1_048_576 ? `${(kb / 1_048_576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
}

export interface CapDir {
  dir: string;
  kb: number;
  /** a file in it was written within RECENT_WRITE_MIN minutes. */
  recentWrite: boolean;
  /** a process runs in, or names, the package that owns the dir (apps/web for apps/web/.next). */
  pkgBusy: boolean;
}

export interface CapVerdict { dir: string; kb: number; remove: boolean; why: string }

/**
 * The size cap: a build output dir over `capBytes` is deleted however recently
 * the checkout was used, because an active checkout is never idle. Never in
 * the primary checkout, never while the checkout's stack is running, never
 * while a process works in the package that owns it, never while it is being
 * written. Dirs at or under the cap are not reported.
 */
export function decideCap(c: { primary: boolean; live: boolean }, dirs: CapDir[], capBytes: number): CapVerdict[] {
  const capKb = capBytes / 1024;
  const gb = fmtKb;
  return dirs.filter((d) => d.kb > capKb).map((d) => {
    const over = `${gb(d.kb)} > cap ${gb(capKb)}`;
    if (c.primary) return { dir: d.dir, kb: d.kb, remove: false, why: `${over} — primary checkout, kept` };
    if (c.live) return { dir: d.dir, kb: d.kb, remove: false, why: `${over} — stack is running, kept` };
    if (d.pkgBusy) return { dir: d.dir, kb: d.kb, remove: false, why: `${over} — a process uses its package, kept` };
    if (d.recentWrite) return { dir: d.dir, kb: d.kb, remove: false, why: `${over} — written < ${RECENT_WRITE_MIN}m ago, kept` };
    return { dir: d.dir, kb: d.kb, remove: true, why: `${over} — delete` };
  });
}

/** The directory whose processes own a build output dir: its parent (apps/web for apps/web/.next). */
export function capOwnerDir(dir: string): string {
  return dir.replace(/\/+$/, '').replace(/\/[^/]+$/, '');
}

export interface CacheTrim { label: string; argv: string[] }

/**
 * Machine-wide cache trims for pressure mode. Each one is skipped when its
 * tool is not installed. pnpm runs in the primary checkout, whose store all
 * worktrees share.
 */
export function cacheTrims(has: (bin: string) => boolean): CacheTrim[] {
  const all: Array<CacheTrim & { bin: string }> = [
    { bin: 'pnpm', label: 'pnpm store prune', argv: ['pnpm', 'store', 'prune'] },
    { bin: 'go', label: 'go clean -cache', argv: ['go', 'clean', '-cache'] },
    { bin: 'bun', label: 'bun pm cache rm', argv: ['bun', 'pm', 'cache', 'rm'] },
    { bin: 'npm', label: 'npm cache clean --force', argv: ['npm', 'cache', 'clean', '--force'] },
  ];
  return all.filter((t) => has(t.bin)).map(({ label, argv }) => ({ label, argv }));
}

/**
 * True when a package install or a Go build runs on the box. A store prune or
 * cache wipe under a running install can break that install, so pressure mode
 * skips the cache trims for this pass.
 */
export function installRunning(commands: string[]): boolean {
  return commands.some((c) =>
    /(^|[\s/])(pnpm|npm|yarn|bun)(\.\S+)?\s+(install|i|add|ci|update|up)(\s|$)/.test(c) ||
    /(^|[\s/])go\s+(build|test|install|mod|run|get)(\s|$)/.test(c));
}
