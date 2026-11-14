import { afterEach, describe, expect, mock, test } from 'bun:test';

function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}

setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona');
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

let snapshotGet: (name: string) => Promise<unknown>;

mock.module('../../shared/daytona', () => ({
  getDaytona: () => ({ snapshot: { get: (name: string) => snapshotGet(name) } }),
  isDaytonaConfigured: () => true,
  listDaytonaSnapshots: async () => [],
}));

const { daytonaProvider, isDaytonaAuthFailure } = await import('./daytona');

afterEach(() => {
  snapshotGet = async () => {
    throw new Error('no snapshot.get stub for this test');
  };
});

snapshotGet = async () => {
  throw new Error('no snapshot.get stub for this test');
};

/**
 * Regression for the 2026-11-11 prod incident: Daytona answered every API call
 * with HTTP 401 for 30+ h, and `getSnapshotState` swallowed the 401 into the
 * generic `'unknown'` state. `ensureSandboxImage` turned that into the opaque
 * "Cannot verify sandbox image …; provider state is unknown"
 * `SnapshotBuildError`, so the startup pre-build and every Daytona session
 * start retried futilely with zero indication that the credential — not the
 * snapshot — was the problem. The Platinum adapter made this exact fix
 * already (`isPlatinumAuthFailure`, platinum-snapshot-state-auth.test.ts): an
 * auth failure must propagate so callers classify it as permanent, while
 * every OTHER lookup error keeps the 'unknown' degradation.
 */
describe('DaytonaAdapter.getSnapshotState — auth failures are never swallowed to "unknown"', () => {
  test('a 401 (statusCode shape) propagates (never returned as a state)', async () => {
    snapshotGet = async () => {
      throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-auth401')).rejects.toThrow(
      'Invalid credentials',
    );
  });

  test('a 403 (axios response.status shape) propagates', async () => {
    snapshotGet = async () => {
      throw Object.assign(new Error('Forbidden'), { response: { status: 403 } });
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-auth403')).rejects.toThrow(
      'Forbidden',
    );
  });

  test('a non-auth failure (timeout, 5xx, network blip) still degrades to "unknown"', async () => {
    snapshotGet = async () => {
      throw new Error('Daytona snapshot.get(kortix-default-x) timed out after 8000ms');
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-blip1')).resolves.toBe('unknown');

    snapshotGet = async () => {
      throw Object.assign(new Error('upstream failed'), { statusCode: 502 });
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-blip2')).resolves.toBe('unknown');

    snapshotGet = async () => {
      throw new Error('fetch failed: ECONNRESET');
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-blip3')).resolves.toBe('unknown');
  });

  test('a missing snapshot still reads "missing" (not-found classification intact)', async () => {
    snapshotGet = async () => {
      throw Object.assign(new Error('Snapshot with name x not found'), { statusCode: 404 });
    };
    await expect(daytonaProvider.getSnapshotState('kortix-default-missing1')).resolves.toBe('missing');
  });
});

describe('isDaytonaAuthFailure — narrow, status-only classification', () => {
  test.each([
    ['statusCode 401', Object.assign(new Error('Invalid credentials'), { statusCode: 401 }), true],
    ['statusCode 403', Object.assign(new Error('forbidden'), { statusCode: 403 }), true],
    [
      'response.status 401 (axios shape)',
      Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }),
      true,
    ],
    ['direct status 403', Object.assign(new Error('forbidden'), { status: 403 }), true],
    ['statusCode 404', Object.assign(new Error('missing'), { statusCode: 404 }), false],
    ['rate limit 429', Object.assign(new Error('ThrottlerException'), { statusCode: 429 }), false],
    ['server 500', Object.assign(new Error('boom'), { statusCode: 500 }), false],
    ['message-only "Invalid credentials" with no status', new Error('Invalid credentials'), false],
  ])('%s → %s', (_label, err, expected) => {
    expect(isDaytonaAuthFailure(err)).toBe(expected);
  });
});
