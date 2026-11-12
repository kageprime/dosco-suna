import { describe, expect, test } from 'bun:test';

import {
  type LegacyBootstrapDeps,
  LEGACY_BOOTSTRAP_METADATA_KEY,
  REQUIRED_RUNTIME_CAPABILITIES,
  bootstrapLegacyRuntime,
} from './legacy-runtime-bootstrap';

/**
 * Pins the verdict-line contract the `every skipped repair says why (KRTX-4754)`
 * tests in `legacy-runtime-bootstrap.test.ts` leave open: the already-staged
 * gate's own verdict (2026-11-11: a spell where `/start` requested the
 * dead-daemon relaunch a dozen times in six minutes shipped not one
 * `[legacy-bootstrap]` line — this gate was the last silent one), the
 * single-line verdicts that keep their own wording (pinned, mid-script
 * deferral), and no second verdict on a run that reached the script.
 */
const CURRENT_HEALTH = {
  daemon: 'ok',
  harness: { id: 'pi', version: null, state: 'ok', ready: true, error: null, session: { id: null, required: false }, turn: null, details: {} },
  capabilities: [...REQUIRED_RUNTIME_CAPABILITIES],
  uptime_s: 600,
  runtime: {
    build: 1788044234,
    components: { agent: 'current', opencode: 'current', cli: 'current', skills: 'current' },
    agentSwapPending: false,
    pinned: false,
    running: {
      cli_sha256: 'c'.repeat(64),
      managed_skills_hash: 'm'.repeat(64),
      agent_sha256: 'a'.repeat(64),
    },
  },
};
/** A legacy-era health body: the daemon answers but reports no runtime block. */
const LEGACY_HEALTH = { daemon: 'ok', uptime_s: 600 };

interface Calls {
  execs: string[][];
  patches: Record<string, unknown>[];
}

function verdictDeps(
  over: Partial<LegacyBootstrapDeps> & { health?: unknown[]; turn?: boolean | null },
  calls: Calls,
  lines: Array<{ message: string; context: unknown }>,
): LegacyBootstrapDeps {
  const healths = over.health ?? [LEGACY_HEALTH, CURRENT_HEALTH];
  let i = 0;
  const clock = { t: 1_000_000 };
  return {
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    manifestBuild: async () => 1788044234,
    fetchHealth: async () => healths[Math.min(i++, healths.length - 1)],
    fetchTurnInFlight: async () => (over.turn === undefined ? false : over.turn),
    providerRunning: over.providerRunning ?? (async () => true),
    exec: async (cmd) => {
      if (cmd.join(' ').includes('127.0.0.1:8000/kortix/health')) {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      calls.execs.push(cmd);
      return { exitCode: 0, stdout: '{"ok":true,"stage":"relaunched","agent_sha256":"a","entrypoint_sha256":"e"}\n', stderr: '' };
    },
    patchMetadata: async (patch) => {
      calls.patches.push(patch);
    },
    claimRun: async (patch) => {
      calls.patches.push(patch);
      return true;
    },
    audit: async () => {},
    log: (message, context) => {
      lines.push({ message, context });
    },
    ...over,
  };
}

const input = (metadata: Record<string, unknown> | null = null, provider = 'platinum') => ({
  sandboxId: 'sb1',
  externalId: 'sbx_1',
  provider,
  metadata,
  reason: 'test' as const,
});

const stagedRecord = {
  state: 'staged',
  attempts: 1,
  manifestBuild: 1788044234,
  lastAttemptAt: new Date(0).toISOString(),
};

describe('the verdict lines the KRTX-4754 tests leave open', () => {
  test('an already-staged gate ships its own verdict and touches nothing', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const lines: Array<{ message: string; context: unknown }> = [];
    const r = await bootstrapLegacyRuntime(
      input({ [LEGACY_BOOTSTRAP_METADATA_KEY]: stagedRecord }, 'daytona'),
      verdictDeps({ health: [LEGACY_HEALTH] }, calls, lines),
    );
    expect(r.outcome).toBe('staged');
    expect(r.detail).toBe('already staged; converges at next start');
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('legacy runtime bootstrap skipped: staged');
    expect(lines[0].context).toEqual({ sandboxId: 'sb1', externalId: 'sbx_1', detail: r.detail });
    // The gate runs before the script: nothing claimed, nothing written, nothing executed.
    expect(calls.execs).toEqual([]);
    expect(calls.patches).toEqual([]);
  });

  test('a completed repair logs only the claim and terminal lines, never a second verdict', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const lines: Array<{ message: string; context: unknown }> = [];
    const r = await bootstrapLegacyRuntime(input(), verdictDeps({}, calls, lines));
    expect(r.outcome).toBe('converged');
    expect(lines.map((l) => l.message).filter((m) => m.includes('skipped'))).toEqual([]);
    expect(lines.map((l) => l.message)).toContain('legacy runtime bootstrap converged');
  });

  test('a repair the box defers mid-script logs the deferral once', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const lines: Array<{ message: string; context: unknown }> = [];
    const deps = verdictDeps(
      {
        exec: async (cmd) => {
          if (cmd.join(' ').includes('127.0.0.1:8000/kortix/health')) {
            return { exitCode: 7, stdout: '', stderr: '' };
          }
          calls.execs.push(cmd);
          return { exitCode: 0, stdout: '{"ok":true,"stage":"deferred_busy","token_rotated":false}\n', stderr: '' };
        },
      },
      calls,
      lines,
    );
    const r = await bootstrapLegacyRuntime(input(), deps);
    expect(r.outcome).toBe('skipped-busy');
    // The claim line ('legacy runtime bootstrap starting') stays; the deferral
    // is the only other line about the run.
    expect(lines.map((l) => l.message).filter((m) => m !== 'legacy runtime bootstrap starting')).toEqual([
      'legacy runtime bootstrap deferred: a turn started during the repair',
    ]);
  });

  test('a pinned daemon ships exactly one blocked line', async () => {
    const calls: Calls = { execs: [], patches: [] };
    const lines: Array<{ message: string; context: unknown }> = [];
    const pinned = {
      ...CURRENT_HEALTH,
      runtime: { ...CURRENT_HEALTH.runtime, pinned: true },
    };
    const r = await bootstrapLegacyRuntime(input(), verdictDeps({ health: [pinned] }, calls, lines));
    expect(r.outcome).toBe('skipped-blocked');
    expect(lines).toHaveLength(1);
    expect(lines[0].message).toBe('daemon is pinned after a rollback — blocked, not repaired');
    expect(JSON.stringify(lines[0].context)).toContain('runtime updates off after a supervisor rollback');
  });
});
