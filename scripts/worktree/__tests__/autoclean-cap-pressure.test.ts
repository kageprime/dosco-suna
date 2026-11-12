import { describe, expect, test } from 'bun:test';
import {
  autocleanConfig, autocleanPass, decideAutoclean, decideCap, capOwnerDir, cacheTrims, installRunning,
  type AutocleanCandidate, type CapDir,
} from '../lib';

const H = 3_600_000;
const GB = 1024 ** 3;
const KB_PER_GB = 1_048_576;
const NOW = Date.parse('2026-11-10T12:00:00Z');
const { config: CFG } = autocleanConfig({});
const cand = (o: Partial<AutocleanCandidate> = {}): AutocleanCandidate => ({
  name: 'wt', primary: false, live: false, busy: false, missing: false,
  meaningfulChanges: 0, unpushed: 0, lastActivity: NOW - 1 * H, ...o,
});
const dir = (o: Partial<CapDir> = {}): CapDir => ({ dir: '/w/suna-a/apps/web/.next', kb: 7 * KB_PER_GB, recentWrite: false, pkgBusy: false, ...o });

describe('cap: build output over the cap', () => {
  test('a 7 GB .next in a stopped checkout is deleted, even when the checkout was used 1h ago', () => {
    expect(decideCap({ primary: false, live: false }, [dir()], CFG.capBytes)).toEqual([
      { dir: '/w/suna-a/apps/web/.next', kb: 7 * KB_PER_GB, remove: true, why: '7.0 GB > cap 3.0 GB — delete' },
    ]);
  });
  test('dirs at or under the cap are not reported', () => {
    expect(decideCap({ primary: false, live: false }, [dir({ kb: 3 * KB_PER_GB }), dir({ kb: 1 })], CFG.capBytes)).toEqual([]);
  });
  test('never in the primary, never under a running stack, a process in its package, or a recent write', () => {
    const one = (c: { primary: boolean; live: boolean }, d: CapDir) => decideCap(c, [d], CFG.capBytes)[0]!;
    expect(one({ primary: true, live: false }, dir()).remove).toBe(false);
    expect(one({ primary: false, live: true }, dir()).remove).toBe(false);
    expect(one({ primary: false, live: false }, dir({ pkgBusy: true })).remove).toBe(false);
    expect(one({ primary: false, live: false }, dir({ recentWrite: true })).remove).toBe(false);
    expect(one({ primary: false, live: true }, dir()).why).toContain('stack is running');
  });
  test('KORTIX_WORKTREE_NEXT_CAP_GB sets the cap; garbage falls back to 3 GB with a warning', () => {
    expect(autocleanConfig({ KORTIX_WORKTREE_NEXT_CAP_GB: '8' }).config.capBytes).toBe(8 * GB);
    const bad = autocleanConfig({ KORTIX_WORKTREE_NEXT_CAP_GB: 'big' });
    expect(bad.config.capBytes).toBe(3 * GB);
    expect(bad.warnings).toHaveLength(1);
    expect(decideCap({ primary: false, live: false }, [dir()], 8 * GB)).toEqual([]);
  });
  test('the package that owns a build dir is its parent', () => {
    expect(capOwnerDir('/w/suna-a/apps/web/.next')).toBe('/w/suna-a/apps/web');
    expect(capOwnerDir('/w/suna-a/apps/cli/dist/')).toBe('/w/suna-a/apps/cli');
  });
});

describe('pressure mode', () => {
  test('at or above 15 GB free: the configured thresholds; merged removes at 24h', () => {
    expect(autocleanPass(CFG, 15 * GB)).toEqual({ pressure: false, sweepIdleMs: 24 * H, removeIdleMs: 48 * H, mergedRemoveIdleMs: 24 * H });
    expect(autocleanPass(CFG, null).pressure).toBe(false);
  });
  test('below 15 GB: sweep regardless of idle, remove at 12h', () => {
    expect(autocleanPass(CFG, 14.9 * GB)).toEqual({ pressure: true, sweepIdleMs: 0, removeIdleMs: 12 * H, mergedRemoveIdleMs: 12 * H });
  });
  test('KORTIX_WORKTREE_PRESSURE_GB moves the threshold', () => {
    const { config } = autocleanConfig({ KORTIX_WORKTREE_PRESSURE_GB: '30' });
    expect(autocleanPass(config, 20 * GB).pressure).toBe(true);
  });
  test('a pressure threshold never exceeds the configured remove idle', () => {
    const { config } = autocleanConfig({ KORTIX_WORKTREE_REMOVE_IDLE: '6h' });
    expect(autocleanPass(config, 1 * GB).removeIdleMs).toBe(6 * H);
  });
  test('under pressure a checkout used 1h ago is swept; one idle 12h, clean and pushed, is removed', () => {
    const pass = autocleanPass(CFG, 5 * GB);
    expect(decideAutoclean(cand(), pass, NOW).sweep).toBe(true);
    expect(decideAutoclean(cand({ lastActivity: NOW - 12 * H }), pass, NOW).remove).toBe(true);
    expect(decideAutoclean(cand({ lastActivity: NOW - 12 * H, unpushed: 2 }), pass, NOW).remove).toBe(false);
  });
  test('pressure never touches a running, busy or primary checkout', () => {
    const pass = autocleanPass(CFG, 1 * GB);
    for (const o of [{ live: true }, { busy: true }, { primary: true }]) {
      const v = decideAutoclean(cand({ ...o, lastActivity: NOW - 100 * H }), pass, NOW);
      expect(v.sweep || v.remove).toBe(false);
    }
  });
  test('cache trims: only installed tools, pnpm prune first', () => {
    expect(cacheTrims(() => true).map((t) => t.label)).toEqual(['pnpm store prune', 'go clean -cache', 'bun pm cache rm', 'npm cache clean --force']);
    expect(cacheTrims((b) => b !== 'go').map((t) => t.argv[0])).toEqual(['pnpm', 'bun', 'npm']);
  });
  test('a running install or go build blocks the cache trims', () => {
    expect(installRunning(['node /opt/pt/bin/pnpm install --frozen-lockfile'])).toBe(true);
    expect(installRunning(['bun install'])).toBe(true);
    expect(installRunning(['/usr/local/go/bin/go build ./...'])).toBe(true);
    expect(installRunning(['pnpm worktree start x', 'next dev --port 13000', 'bun run src/index.ts'])).toBe(false);
  });
});

describe('merged branches', () => {
  const pass = autocleanPass(CFG, 50 * GB);
  test('merged counts as pushed: removed at 24h idle, not 48h', () => {
    expect(decideAutoclean(cand({ lastActivity: NOW - 24 * H, unpushed: 5, merged: true }), pass, NOW).remove).toBe(true);
    expect(decideAutoclean(cand({ lastActivity: NOW - 24 * H, unpushed: 0 }), pass, NOW).remove).toBe(false);
    expect(decideAutoclean(cand({ lastActivity: NOW - 23 * H, merged: true }), pass, NOW).remove).toBe(false);
  });
  test('merged never removes a checkout with uncommitted work, nor the current one', () => {
    expect(decideAutoclean(cand({ lastActivity: NOW - 30 * H, merged: true, meaningfulChanges: 1 }), pass, NOW).remove).toBe(false);
    expect(decideAutoclean(cand({ lastActivity: NOW - 30 * H, merged: true, current: true }), pass, NOW).remove).toBe(false);
  });
  test('the reason names the merge', () => {
    expect(decideAutoclean(cand({ lastActivity: NOW - 30 * H, merged: true, unpushed: null }), pass, NOW).why).toContain('merged into dev');
  });
});
