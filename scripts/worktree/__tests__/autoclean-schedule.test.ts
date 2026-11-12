import { describe, expect, test } from 'bun:test';
import {
  cronLine, scheduledCommand, hasCronLine, currentCronLine, withCronLine, withoutCronLine, CRON_MARK, LOOP_MARK,
  generationOf, loopScript, isLoopFor, pickScheduler, bundleRebuildReason, parseStamp, type BundleStamp, type ScheduleTarget,
} from '../lib';

const T: ScheduleTarget = { repo: '/w/suna', bun: '/u/bin/bun', bundle: '/w/.kortix/bin/worktree-autoclean.js', path: '/u/bin:/usr/bin', kortixHome: '/w/.kortix', log: '/w/.kortix/worktrees/autoclean.log' };

describe('scheduled command', () => {
  test('runs the bundle, not a checkout, against an explicit repo', () => {
    const cmd = scheduledCommand(T);
    expect(cmd).toContain("'/u/bin/bun' '/w/.kortix/bin/worktree-autoclean.js' autoclean --yes --quiet --scheduled --repo '/w/suna'");
    expect(cmd).toContain("KORTIX_WORKTREE_REPO='/w/suna'");
    expect(cmd.startsWith("cd '/w/suna' && ")).toBe(true);
    expect(cmd).not.toContain('scripts/worktree/cli.ts');
  });
  test('cron: every 15 minutes, marked, no %', () => {
    const line = cronLine(T);
    expect(line.startsWith('*/15 * * * * ')).toBe(true);
    expect(line.endsWith(CRON_MARK)).toBe(true);
    expect(() => cronLine({ ...T, repo: '/w/100%' })).toThrow();
  });
  test('install is idempotent, replaces an old hourly line, keeps other lines; uninstall removes only ours', () => {
    const old = `17 * * * * cd '/w/suna' && bun scripts/worktree/cli.ts autoclean --yes --quiet ${CRON_MARK}`;
    const base = 'MAILTO=""\n0 3 * * * backup\n';
    const once = withCronLine(base + old + '\n', cronLine(T));
    expect(currentCronLine(once)).toBe(cronLine(T));
    expect(withCronLine(once, cronLine(T))).toBe(once);
    expect(once.split('\n').filter((l) => l.endsWith(CRON_MARK))).toHaveLength(1);
    expect(hasCronLine(base)).toBe(false);
    expect(currentCronLine(base)).toBeNull();
    expect(withoutCronLine(once)).toBe(base);
  });
});

describe('fallback loop (no cron daemon)', () => {
  const cmd = scheduledCommand(T);
  const gen = generationOf(cmd);
  const script = loopScript({ cmd, genFile: '/w/.kortix/worktrees/autoclean-loop.gen', gen });
  test('generation is stable per command and changes with it', () => {
    expect(generationOf(cmd)).toBe(gen);
    expect(generationOf(scheduledCommand({ ...T, bun: '/u/bin/bun2' }))).not.toBe(gen);
  });
  test('marker and generation lead the script, so a ps listing finds it', () => {
    expect(script.startsWith(`: ${LOOP_MARK} '${gen}'; `)).toBe(true);
    expect(isLoopFor(`sh -c ${script}`, gen)).toBe(true);
    expect(isLoopFor(`sh -c ${script}`, 'othergen')).toBe(false);
    expect(isLoopFor('bun scripts/worktree/cli.ts autoclean', gen)).toBe(false);
  });
  test('sleeps 15 min first, runs only while the generation file holds its gen, exits on its own', () => {
    expect(script).toContain('sleep 900');
    expect(script.indexOf('sleep 900')).toBeLessThan(script.indexOf(cmd));
    expect(script).toContain(`|| exit 0`);
  });
  test('the loop really exits when the generation file changes', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/wt-loop-${process.pid}`;
    await Bun.$`mkdir -p ${dir}`;
    const genFile = `${dir}/gen`;
    await Bun.write(genFile, 'g1');
    const s = loopScript({ cmd: `echo tick >> ${dir}/out`, genFile, gen: 'g1', everyMin: 0.001 });
    const p = Bun.spawn(['sh', '-c', s]);
    await Bun.sleep(300);
    await Bun.write(genFile, 'g2');
    const code = await Promise.race([p.exited, Bun.sleep(3000).then(() => 'timeout')]);
    expect(code).toBe(0);
    expect((await Bun.file(`${dir}/out`).text()).includes('tick')).toBe(true);
    await Bun.$`rm -rf ${dir}`;
  });
});

describe('scheduler choice', () => {
  test('cron only when a cron daemon runs (macOS always); else the loop', () => {
    expect(pickScheduler({ platform: 'linux', hasCrontab: true, cronDaemon: true, hasSh: true })).toBe('cron');
    expect(pickScheduler({ platform: 'linux', hasCrontab: true, cronDaemon: false, hasSh: true })).toBe('loop');
    expect(pickScheduler({ platform: 'linux', hasCrontab: false, cronDaemon: false, hasSh: true })).toBe('loop');
    expect(pickScheduler({ platform: 'darwin', hasCrontab: true, cronDaemon: false, hasSh: true })).toBe('cron');
    expect(pickScheduler({ platform: 'linux', hasCrontab: false, cronDaemon: false, hasSh: false })).toBe('none');
  });
});

describe('bundle staleness', () => {
  const stamp: BundleStamp = { sourceCommitMs: 1000, sourceRev: 'abc', dirty: false, builtAt: '2026-11-10T00:00:00Z' };
  const clean = (commitMs: number) => ({ commitMs, rev: 'x', dirty: false });
  test('missing bundle or stamp: build', () => {
    expect(bundleRebuildReason(null, true, clean(1))).toBe('bundle missing');
    expect(bundleRebuildReason(stamp, false, clean(1))).toBe('bundle missing');
    expect(bundleRebuildReason(stamp, false, { ...clean(1), dirty: true })).toBe('bundle missing');
  });
  test('newer committed code rebuilds; same or older never downgrades', () => {
    expect(bundleRebuildReason(stamp, true, clean(2000))).toBe('bundle is older than the running code');
    expect(bundleRebuildReason(stamp, true, clean(1000))).toBeNull();
    expect(bundleRebuildReason(stamp, true, clean(500))).toBeNull();
    expect(bundleRebuildReason(stamp, true, { commitMs: null, rev: '', dirty: false })).toBeNull();
  });
  test('uncommitted code never replaces a bundle; clean code replaces a dirty-built bundle', () => {
    expect(bundleRebuildReason(stamp, true, { ...clean(9999), dirty: true })).toBeNull();
    expect(bundleRebuildReason({ ...stamp, dirty: true }, true, clean(1))).toBe('bundle was built from uncommitted code');
  });
  test('stamp parsing tolerates garbage', () => {
    expect(parseStamp(JSON.stringify(stamp))).toEqual(stamp);
    expect(parseStamp('{')).toBeNull();
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp('{"x":1}')).toBeNull();
  });
});
