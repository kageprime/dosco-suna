/**
 * The always-on autoclean schedule. Pure rules only; cli.ts builds, probes and
 * spawns.
 *
 * The scheduled run executes a standalone bundle of this CLI
 * (`$KORTIX_HOME/bin/worktree-autoclean.js`), not a checkout: the primary
 * checkout is often hundreds of commits behind dev, and a worktree can be
 * removed. `create` and `start` rebuild the bundle when the code they run is
 * newer, and (re)install the schedule when it is missing or points elsewhere.
 *
 * Two schedulers, one command:
 * - cron, when a cron daemon runs (Linux `cron`/`crond`, macOS always);
 * - otherwise a detached `sh` loop (PTXP boxes have no cron daemon). The loop
 *   exits on its own when its generation file changes, so a reinstall never
 *   kills a process.
 */

export const AUTOCLEAN_EVERY_MIN = 15;
/** Trailing marker of the one crontab line autoclean owns. */
export const CRON_MARK = '# kortix-worktree-autoclean';
/** Leads the fallback loop's script; `ps` shows it. */
export const LOOP_MARK = 'kortix-worktree-autoclean-loop';
export const BUNDLE_NAME = 'worktree-autoclean.js';

/** Single-quote a string for /bin/sh. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface ScheduleTarget {
  /** the primary checkout: the repo autoclean runs against. */
  repo: string;
  bun: string;
  bundle: string;
  path: string;
  kortixHome: string;
  log: string;
}

/**
 * The scheduled command: run the bundle against an explicit repo root.
 * cron starts with an empty environment, so PATH and KORTIX_HOME are pinned.
 * `cd` fails when the repo is gone, and then nothing runs. No `%` may appear:
 * cron turns it into a newline.
 */
export function scheduledCommand(t: ScheduleTarget): string {
  const cmd = `cd ${shQuote(t.repo)} && PATH=${shQuote(t.path)} KORTIX_HOME=${shQuote(t.kortixHome)} KORTIX_WORKTREE_REPO=${shQuote(t.repo)} ${shQuote(t.bun)} ${shQuote(t.bundle)} autoclean --yes --quiet --scheduled --repo ${shQuote(t.repo)} >> ${shQuote(t.log)} 2>&1`;
  if (cmd.includes('%')) throw new Error('crontab line may not contain "%"');
  return cmd;
}

/** The one crontab line: every 15 minutes, marked. */
export function cronLine(t: ScheduleTarget): string {
  return `*/${AUTOCLEAN_EVERY_MIN} * * * * ${scheduledCommand(t)} ${CRON_MARK}`;
}

export function hasCronLine(crontab: string): boolean {
  return crontab.split('\n').some((l) => l.trimEnd().endsWith(CRON_MARK));
}

/** Our line in the crontab, or null. */
export function currentCronLine(crontab: string): string | null {
  return crontab.split('\n').find((l) => l.trimEnd().endsWith(CRON_MARK))?.trimEnd() ?? null;
}

/** The crontab with our line replaced (idempotent) and every other line kept. */
export function withCronLine(crontab: string, line: string): string {
  const kept = crontab.split('\n').filter((l) => !l.trimEnd().endsWith(CRON_MARK));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return [...kept, line].join('\n') + '\n';
}

export function withoutCronLine(crontab: string): string {
  const kept = crontab.split('\n').filter((l) => !l.trimEnd().endsWith(CRON_MARK));
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return kept.length ? kept.join('\n') + '\n' : '';
}

/** A short, stable id of a scheduled command: a loop runs only while the generation file holds it. */
export function generationOf(cmd: string): string {
  return Bun.hash(cmd).toString(36);
}

/**
 * The fallback loop body for `sh -c <body>`. The marker and generation lead
 * the body, so a truncated `ps` line still shows them. It sleeps first (create/start just ran autoclean inline), runs only while
 * `genFile` holds `gen`, and exits on its own once it does not.
 */
export function loopScript(o: { cmd: string; genFile: string; gen: string; everyMin?: number }): string {
  const sec = (o.everyMin ?? AUTOCLEAN_EVERY_MIN) * 60;
  const alive = `[ "$(cat ${shQuote(o.genFile)} 2>/dev/null)" = ${shQuote(o.gen)} ]`;
  return `: ${LOOP_MARK} ${shQuote(o.gen)}; while ${alive}; do sleep ${sec}; ${alive} || exit 0; ${o.cmd}; done`;
}

/** True when a `ps` command line is our loop for `gen`. */
export function isLoopFor(command: string, gen: string): boolean {
  return command.includes(`${LOOP_MARK} ${shQuote(gen)}`);
}

export type Scheduler = 'cron' | 'loop' | 'none';

/**
 * cron when `crontab` exists and a cron daemon runs (macOS launchd starts cron
 * on demand, so darwin counts as running); otherwise the detached loop when
 * `sh` exists.
 */
export function pickScheduler(o: { platform: string; hasCrontab: boolean; cronDaemon: boolean; hasSh: boolean }): Scheduler {
  if (o.hasCrontab && (o.platform === 'darwin' || o.cronDaemon)) return 'cron';
  return o.hasSh ? 'loop' : 'none';
}

/** Written next to the bundle: what source it was built from. */
export interface BundleStamp {
  /** committer time (ms) of the last commit that touched scripts/worktree in the source checkout. */
  sourceCommitMs: number;
  sourceRev: string;
  /** built from a checkout with uncommitted changes under scripts/worktree. */
  dirty: boolean;
  builtAt: string;
}

export interface RunningCode { commitMs: number | null; rev: string; dirty: boolean }

/**
 * Why the bundle must be (re)built from the running code, or null. A missing
 * bundle is always built. Otherwise a checkout with uncommitted changes under
 * scripts/worktree never replaces a bundle on its own (explicit
 * `--install-cron` does); a bundle built from dirty code is replaced by clean
 * code; and newer committed code replaces older. Older code (a branch cut
 * before the bundle's source) never downgrades it.
 */
export function bundleRebuildReason(stamp: BundleStamp | null, bundleExists: boolean, running: RunningCode): string | null {
  if (!bundleExists || !stamp) return 'bundle missing';
  if (running.dirty) return null;
  if (stamp.dirty) return 'bundle was built from uncommitted code';
  if (running.commitMs !== null && running.commitMs > stamp.sourceCommitMs) return 'bundle is older than the running code';
  return null;
}

export function parseStamp(text: string | null): BundleStamp | null {
  if (!text) return null;
  try {
    const s = JSON.parse(text);
    return typeof s?.sourceCommitMs === 'number' && typeof s?.sourceRev === 'string' ? { dirty: false, builtAt: '', ...s } : null;
  } catch { return null; }
}
