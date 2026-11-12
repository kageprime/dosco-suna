import { describe, expect, test } from 'bun:test';
import {
  autocleanConfig, parsePorcelain, meaningfulChanges, NOISE_PATHS, lastActivity, decideAutoclean,
  diskLevel, diskThresholds, parseDfFreeBytes, 
  type AutocleanCandidate, type AutocleanConfig,
} from '../lib';

const H = 3_600_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const GB = 1024 ** 3;
const CFG: AutocleanConfig = { enabled: true, sweepIdleMs: 24 * H, removeIdleMs: 48 * H, mergedRemoveIdleMs: 24 * H, pressureRemoveIdleMs: 12 * H, capBytes: 3 * GB, pressureFreeBytes: 15 * GB };
const cand = (o: Partial<AutocleanCandidate> = {}): AutocleanCandidate => ({
  name: 'wt', primary: false, live: false, busy: false, missing: false,
  meaningfulChanges: 0, unpushed: 0, lastActivity: NOW - 72 * H, ...o,
});
const act = (o: Partial<AutocleanCandidate>) => {
  const v = decideAutoclean(cand(o), CFG, NOW);
  return v.remove ? 'remove' : v.sweep ? 'sweep' : 'keep';
};

describe('autocleanConfig', () => {
  test('defaults: on, 24h sweep, 48h remove, 24h merged, 12h pressure, 3 GB cap, 15 GB pressure', () => {
    expect(autocleanConfig({})).toEqual({ config: CFG, warnings: [] });
  });
  test('env overrides the thresholds', () => {
    const { config } = autocleanConfig({ KORTIX_WORKTREE_SWEEP_IDLE: '6h', KORTIX_WORKTREE_REMOVE_IDLE: '1w' });
    expect(config.sweepIdleMs).toBe(6 * H);
    expect(config.removeIdleMs).toBe(7 * 24 * H);
  });
  test('an invalid duration falls back to the default and warns', () => {
    const { config, warnings } = autocleanConfig({ KORTIX_WORKTREE_REMOVE_IDLE: '2 days' });
    expect(config.removeIdleMs).toBe(48 * H);
    expect(warnings).toHaveLength(1);
  });
  test('KORTIX_WORKTREE_AUTOCLEAN=0|false|off|no turns it off; anything else keeps it on', () => {
    for (const v of ['0', 'false', 'OFF', 'no']) expect(autocleanConfig({ KORTIX_WORKTREE_AUTOCLEAN: v }).config.enabled).toBe(false);
    for (const v of ['1', 'true', '', 'yes']) expect(autocleanConfig({ KORTIX_WORKTREE_AUTOCLEAN: v }).config.enabled).toBe(true);
  });
});

describe('parsePorcelain + meaningfulChanges', () => {
  test('modified, untracked, rename, quoted path', () => {
    const out = ' M apps/web/src/lib/seo/content-timestamps.json\n?? scratch/\nR  old.ts -> new.ts\n M "a b.ts"\n';
    expect(parsePorcelain(out)).toEqual([
      { xy: ' M', path: 'apps/web/src/lib/seo/content-timestamps.json' },
      { xy: '??', path: 'scratch' },
      { xy: 'R ', path: 'new.ts' },
      { xy: ' M', path: 'a b.ts' },
    ]);
  });
  test('a change only to a noise path is not a meaningful change', () => {
    expect(meaningfulChanges(parsePorcelain(` M ${NOISE_PATHS[0]}\n`))).toEqual([]);
    expect(meaningfulChanges(parsePorcelain(` M ${NOISE_PATHS[0]}\n M apps/api/src/x.ts\n`)).map((e) => e.path)).toEqual(['apps/api/src/x.ts']);
  });
});

describe('lastActivity', () => {
  test('newest of createdAt, lastUsedAt, HEAD commit, changed-file mtimes', () => {
    expect(lastActivity({ createdAt: new Date(NOW - 90 * H).toISOString(), lastUsedAt: new Date(NOW - 50 * H).toISOString(), headCommitMs: NOW - 60 * H, changedMtimesMs: [NOW - 70 * H] })).toBe(NOW - 50 * H);
    expect(lastActivity({ createdAt: new Date(NOW - 90 * H).toISOString(), headCommitMs: NOW - 60 * H, changedMtimesMs: [NOW - 2 * H] })).toBe(NOW - 2 * H);
  });
  test('missing and invalid inputs are ignored; nothing known is null', () => {
    expect(lastActivity({ createdAt: 'garbage', headCommitMs: null })).toBeNull();
    expect(lastActivity({ lastUsedAt: new Date(NOW).toISOString() })).toBe(NOW);
  });
});

describe('decideAutoclean', () => {
  test('primary, live and busy checkouts are never touched', () => {
    expect(act({ primary: true })).toBe('keep');
    expect(act({ live: true })).toBe('keep');
    expect(act({ busy: true })).toBe('keep');
    expect(act({ busy: true, missing: true })).toBe('keep');
  });
  test('a directory git does not list as a worktree is never touched', () => {
    expect(act({ unregistered: true })).toBe('keep');
  });
  test('idle < 24h: keep; 24h–48h: sweep; ≥ 48h clean and pushed: remove', () => {
    expect(act({ lastActivity: NOW - 23 * H })).toBe('keep');
    expect(act({ lastActivity: NOW - 24 * H })).toBe('sweep');
    expect(act({ lastActivity: NOW - 47 * H })).toBe('sweep');
    expect(act({ lastActivity: NOW - 48 * H })).toBe('remove');
  });
  test('real uncommitted changes keep the worktree, but its build output is swept', () => {
    expect(act({ meaningfulChanges: 1 })).toBe('sweep');
  });
  test('a branch with commits on no remote keeps the worktree; unknown push state too', () => {
    expect(act({ unpushed: 3 })).toBe('sweep');
    expect(act({ unpushed: null })).toBe('sweep');
  });
  test('the worktree the command runs for is never removed', () => {
    expect(act({ current: true })).toBe('sweep');
  });
  test('unknown activity touches nothing', () => {
    expect(act({ lastActivity: null })).toBe('keep');
  });
  test('a missing directory frees its slot only after the remove threshold', () => {
    expect(act({ missing: true, lastActivity: NOW - 1 * H })).toBe('keep');
    expect(act({ missing: true, lastActivity: NOW - 49 * H })).toBe('remove');
  });
  test('thresholds come from the config', () => {
    const v = decideAutoclean(cand({ lastActivity: NOW - 3 * H }), { sweepIdleMs: 1 * H, removeIdleMs: 2 * H }, NOW);
    expect(v.remove).toBe(true);
  });
  test('every verdict carries a reason', () => {
    for (const o of [{}, { live: true }, { meaningfulChanges: 2 }, { lastActivity: NOW }]) expect(decideAutoclean(cand(o), CFG, NOW).why.length).toBeGreaterThan(0);
  });
});

describe('disk guard', () => {
  test('levels: ≥ 10 GB ok, < 10 GB warn, < 4 GB refuse', () => {
    expect(diskLevel(41 * GB)).toBe('ok');
    expect(diskLevel(10 * GB)).toBe('ok');
    expect(diskLevel(9.9 * GB)).toBe('warn');
    expect(diskLevel(4 * GB)).toBe('warn');
    expect(diskLevel(3.9 * GB)).toBe('refuse');
    expect(diskLevel(46 * 1024 ** 2)).toBe('refuse');
  });
  test('thresholds: defaults, env overrides, garbage ignored, refuse capped at warn', () => {
    expect(diskThresholds({})).toEqual({ warnBytes: 10 * GB, refuseBytes: 4 * GB });
    expect(diskThresholds({ KORTIX_WORKTREE_DISK_WARN_GB: '30', KORTIX_WORKTREE_DISK_REFUSE_GB: '8' })).toEqual({ warnBytes: 30 * GB, refuseBytes: 8 * GB });
    expect(diskThresholds({ KORTIX_WORKTREE_DISK_WARN_GB: 'lots', KORTIX_WORKTREE_DISK_REFUSE_GB: '-1' })).toEqual({ warnBytes: 10 * GB, refuseBytes: 4 * GB });
    expect(diskThresholds({ KORTIX_WORKTREE_DISK_WARN_GB: '2' })).toEqual({ warnBytes: 2 * GB, refuseBytes: 2 * GB });
  });
  test('parses df -Pk', () => {
    const out = 'Filesystem     1024-blocks     Used Available Capacity Mounted on\n/dev/vdb         102626232 62543888  40065960      61% /work\n';
    expect(parseDfFreeBytes(out)).toBe(40065960 * 1024);
    expect(parseDfFreeBytes('')).toBeNull();
  });
});

