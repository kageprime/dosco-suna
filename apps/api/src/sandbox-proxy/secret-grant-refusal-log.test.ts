/**
 * The `[PREVIEW] Secret grant refused prompt` warn is on a burst path
 * (KRTX-4016): a container-wide fork burst refuses EVERY prompt for minutes,
 * and the per-prompt warn became the log-pattern spike the issue files on —
 * 52 identical lines in one 4-minute window. The rate limit keeps one line per
 * minute per process, with the suppressed count in the line, so the burst stays
 * measurable without the wallpaper. The refusal RESPONSE is unchanged and not
 * under test here — this file pins only the log emission.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SecretGrantResolutionError } from '../projects/lib/secret-grant';
import {
  logSecretGrantRefusal,
  runPrePromptEnvSync,
  type PrePromptEnvSyncDeps,
  __resetSecretGrantRefusalLogForTests,
} from './pre-prompt-env-sync';

const SBX = 'sb-1';
const PORT = 8000;
const T0 = 1_000_000;

describe('logSecretGrantRefusal — one warn per minute, aggregate the rest', () => {
  let warns: string[];
  let mock: ReturnType<typeof spyOn>;

  afterEach(() => {
    mock.mockRestore();
    __resetSecretGrantRefusalLogForTests();
  });

  test('the first refusal warns, with no suppressed suffix', () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    logSecretGrantRefusal(SBX, PORT, 'could not resolve the secrets grant', T0);

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('[PREVIEW] Secret grant refused prompt for sb-1:8000');
    expect(warns[0]).toContain('could not resolve the secrets grant');
    expect(warns[0]).not.toContain('+');
  });

  test('refusals inside the window are suppressed, not logged', () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    logSecretGrantRefusal(SBX, PORT, 'first', T0);
    logSecretGrantRefusal(SBX, PORT, 'second', T0 + 5_000);
    logSecretGrantRefusal(SBX, PORT, 'third', T0 + 59_999);

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('first');
  });

  test('the first refusal after the window warns with the suppressed count', () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    logSecretGrantRefusal(SBX, PORT, 'first', T0);
    logSecretGrantRefusal(SBX, PORT, 'burst-1', T0 + 10_000);
    logSecretGrantRefusal(SBX, PORT, 'burst-2', T0 + 20_000);
    logSecretGrantRefusal(SBX, PORT, 'after-window', T0 + 61_000);

    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain('after-window');
    expect(warns[1]).toContain('+2 suppressed since the previous line');
  });

  test('a suppression after a long idle span does not claim a one-minute window', () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    logSecretGrantRefusal(SBX, PORT, 'first', T0);
    logSecretGrantRefusal(SBX, PORT, 'suppressed', T0 + 10_000);
    // Hours later, the next refusal flushes the stale count — the label must
    // not tie it to "the last minute" (emission is traffic-driven).
    logSecretGrantRefusal(SBX, PORT, 'much-later', T0 + 3 * 60 * 60_000);

    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain('much-later');
    expect(warns[1]).toContain('+1 suppressed since the previous line');
    expect(warns[1]).not.toContain('minute');
  });

  test('a sustained storm emits at most one line per minute', () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    for (let minute = 0; minute < 5; minute++) {
      for (let i = 0; i < 30; i++) {
        logSecretGrantRefusal(SBX, PORT, 'refused', T0 + minute * 60_000 + i * 100);
      }
    }

    expect(warns).toHaveLength(5);
    expect(warns[4]).toContain('+29 suppressed since the previous line');
  });

  test('the real pre-prompt catch path logs the rate-limited refusal and still answers 503', async () => {
    warns = [];
    mock = spyOn(console, 'warn').mockImplementation((msg: string) => {
      warns.push(msg);
    });

    const deps: PrePromptEnvSyncDeps = {
      syncEnv: async () => {
        throw new SecretGrantResolutionError('engineering', new Error('git clone failed (spawn EAGAIN)'));
      },
      remintGrant: async () => ({ action: 'skip' as const }),
      bindTurnIdentity: async () => true,
      generateTitle: async () => undefined,
    };
    const response = await runPrePromptEnvSync(
      {
        record: {
          accountId: 'acct-1',
          projectId: 'proj-1',
          sessionId: 'sess-1',
          externalId: 'ext-1',
          agentName: 'kortix',
          provider: 'daytona',
        },
        sandboxId: 'sb-1',
        port: 8000,
        userId: 'user-1',
        origin: 'http://app.local',
        previewUrl: 'http://sandbox.local',
        providerHeaders: {},
        serviceKey: 'svc-key',
        requestedAgent: null,
        bindTurnIdentity: false,
        body: undefined,
        incomingHeaders: new Headers(),
      },
      deps,
    );

    expect(response?.status).toBe(503);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('[PREVIEW] Secret grant refused prompt for sb-1:8000');
    expect(warns[0]).toContain('git clone failed (spawn EAGAIN)');
  });
});
