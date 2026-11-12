import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '../../lib/logger';
import { admitRunningSandbox } from '../admit-running-sandbox';
import { MIN_DAEMON_BUILD } from '../admission';

const BASE_INPUT = {
  externalId: 'ext_1',
  userId: 'user_1',
  sessionId: 'session_1',
};

describe('admitRunningSandbox', () => {
  const originalEnforce = process.env.RUNTIME_ADMISSION_ENFORCE;
  afterEach(() => {
    if (originalEnforce === undefined) delete process.env.RUNTIME_ADMISSION_ENFORCE;
    else process.env.RUNTIME_ADMISSION_ENFORCE = originalEnforce;
  });

  test('reports observe-only refusal as a warning and enforced refusal as an error', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    const error = spyOn(logger, 'error').mockImplementation(() => {});
    const deps = { fetchHealth: async () => ({ capabilities: [] }) };
    try {
      process.env.RUNTIME_ADMISSION_ENFORCE = 'false';
      expect((await admitRunningSandbox(BASE_INPUT, deps)).admitted).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[runtime-convergence] admission refused — observe only, box still used',
        expect.objectContaining({ failed_check: 'config_release_capability' }),
      );
      expect(error).not.toHaveBeenCalled();

      process.env.RUNTIME_ADMISSION_ENFORCE = 'true';
      expect((await admitRunningSandbox(BASE_INPUT, deps)).admitted).toBe(false);
      expect(error).toHaveBeenCalledWith(
        '[runtime-convergence] admission refused — box replaced, not used',
        expect.objectContaining({ failed_check: 'config_release_capability' }),
      );
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('admits a box whose health proves every check — pi reports no catalog_fingerprint (KRTX-4642 regression)', async () => {
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => ({
        capabilities: ['config.release.v1'],
        runtime_truth: { daemon_build: MIN_DAEMON_BUILD + 1 },
      }),
    });
    expect(verdict.admitted).toBe(true);
  });

  test('a box that cannot be reached for health reports nothing and is refused, not admitted by default', async () => {
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => null,
    });
    expect(verdict.admitted).toBe(false);
  });

  test('never throws — a health fetch that throws is swallowed and the box is admitted rather than blocking session open', async () => {
    const verdict = await admitRunningSandbox(BASE_INPUT, {
      fetchHealth: async () => {
        throw new Error('boom');
      },
    });
    expect(verdict.admitted).toBe(true);
  });

  test('hands its health read to the turn-start gates, and a failing hand-off changes nothing', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const health = { capabilities: [] };
      const noted: Array<[string, unknown]> = [];
      const verdict = await admitRunningSandbox(BASE_INPUT, {
        fetchHealth: async () => health,
        noteHealth: async (sessionId, body) => {
          noted.push([sessionId, body]);
        },
      });
      expect(noted).toEqual([['session_1', health]]);
      const failing = await admitRunningSandbox(BASE_INPUT, {
        fetchHealth: async () => health,
        noteHealth: async () => {
          throw new Error('memo down');
        },
      });
      expect(failing).toEqual(verdict);
      // No health, nothing to hand off.
      let calls = 0;
      await admitRunningSandbox(BASE_INPUT, {
        fetchHealth: async () => null,
        noteHealth: async () => {
          calls += 1;
        },
      });
      expect(calls).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});
