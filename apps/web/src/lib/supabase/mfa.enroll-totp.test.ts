import { beforeEach, expect, mock, test } from 'bun:test';

import type { FactorInfo } from './mfa';

// ─── Supabase client stub ───────────────────────────────────────────────────
// `enrollTotp` reads `supabase.auth.mfa.listFactors`, then unenrolls stale
// unverified TOTP factors and enrolls the new one. Mock `./client` before the
// module under test is imported, then drive each branch from the holders
// below (the repo pattern: mock.module + dynamic import).
let listed: { all?: FactorInfo[] } | null;
let enrollResult: { data?: unknown; error?: { message: string } | null };
const unenrollCalls: string[] = [];
const enrollCalls: unknown[] = [];

mock.module('./client', () => ({
  createClient: () => ({
    auth: {
      mfa: {
        listFactors: async () => ({ data: listed }),
        unenroll: async (args: { factorId: string }) => {
          unenrollCalls.push(args.factorId);
          return { data: {}, error: null };
        },
        enroll: async (args: unknown) => {
          enrollCalls.push(args);
          return enrollResult;
        },
      },
    },
  }),
}));

const { supabaseMFAService } = await import('./mfa');

const QR = 'data:image/svg+xml;utf8,%3Csvg%3E';
const ENROLL_ARGS = { factorType: 'totp', friendlyName: expect.any(String) };

beforeEach(() => {
  listed = null;
  enrollResult = {};
  unenrollCalls.length = 0;
  enrollCalls.length = 0;
});

test('clears a stale unverified TOTP factor before enrolling, leaves the rest', async () => {
  listed = {
    all: [
      { id: 'stale-totp', factor_type: 'totp', status: 'unverified' },
      { id: 'verified-totp', factor_type: 'totp', status: 'verified' },
      { id: 'phone-unverified', factor_type: 'phone', status: 'unverified' },
    ],
  };
  enrollResult = { data: { id: 'new-totp', totp: { qr_code: QR, secret: 'SECRET' } }, error: null };

  const result = await supabaseMFAService.enrollTotp();

  expect(unenrollCalls).toEqual(['stale-totp']);
  expect(enrollCalls).toEqual([ENROLL_ARGS]);
  expect(result).toEqual({ factorId: 'new-totp', qr: QR, secret: 'SECRET' });
});

test('turns a missing QR code into a thrown error', async () => {
  listed = { all: [] };
  enrollResult = { data: { id: 'new-totp', totp: { qr_code: null, secret: 'SECRET' } }, error: null };

  expect(supabaseMFAService.enrollTotp()).rejects.toThrow('Enrollment returned no QR code');
  expect(unenrollCalls).toEqual([]);
});

test('surfaces the enroll error message', async () => {
  listed = { all: [] };
  enrollResult = { data: null, error: { message: 'enroll failed' } };

  expect(supabaseMFAService.enrollTotp()).rejects.toThrow('enroll failed');
  expect(unenrollCalls).toEqual([]);
});
