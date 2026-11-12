// A Platinum outage fails every volumes call at its timeout budget, and one
// warn line per call turned the 2026-11-10 control-plane hang into ~800 lines
// across dozens of route shapes in four hours (KRTX-4672, four infra-sweep
// issues for one incident). The failure LINE is throttled the way the global
// error handler throttles dead-credential refusals (shared/log-window.ts):
// the first failure per route shape logs immediately, later ones count toward
// the next emitted line's `suppressed`. The behavior is untouched: every call
// still rejects with its typed 503, and the degradation signal of the limits
// read still logs.
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { logger } from '../lib/logger';

mock.module('../shared/platinum', () => ({
  isPlatinumConfigured: () => true,
  platinumRegionControlPlane: () => null,
  // The outage shape: every call hangs until its caller-provided budget and
  // then rejects — no response at all.
  platinumFetch: async (): Promise<Response> => {
    throw new Error('platinum GET /v1/volumes/limits timed out after caller-provided budget');
  },
}));

const { DriveStorageError, getDriveVolume, listVolumeMounts, platinumVolumeLimits } = await import('./volumes');

const warn = spyOn(logger, 'warn').mockImplementation(() => {});
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

const read = async (name: string): Promise<unknown> =>
  getDriveVolume({ name, region: null, unfenced: true as const }).catch((e: unknown) => e);

describe('drives Platinum failure lines are throttled (KRTX-4672)', () => {
  test('fifteen volumes on a hung control plane log ONE failure line, not one per volume', async () => {
    for (let i = 0; i < 15; i += 1) {
      const err = (await read(`kd-${i.toString(16).padStart(22, '0')}`)) as InstanceType<typeof DriveStorageError>;
      expect(err).toBeInstanceOf(DriveStorageError);
      expect(err.status).toBe(503);
      expect(err.code).toBe('drive_storage_unavailable');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    // The line keeps the real volume it failed on; the count rides the context.
    expect(message).toContain('kd-0000000000000000000000');
    expect(message).toContain('failed:');
    expect(context.suppressed).toBe(0);
  });

  test('a different route shape logs immediately beside the suppressed one', async () => {
    const err = (await listVolumeMounts({ name: 'kd-9be08b8bf0d24c21a3f6', region: null, unfenced: true as const }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof DriveStorageError>;
    expect(err).toBeInstanceOf(DriveStorageError);
    const [message] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toContain('GET /v1/volumes/kd-9be08b8bf0d24c21a3f6/mounts failed:');
  });

  test('the limits-read degradation signal still logs its warn', async () => {
    const limits = await platinumVolumeLimits();
    expect(limits).toEqual({});
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('reading the Platinum volume limits failed:'))).toBe(true);
  });
});
