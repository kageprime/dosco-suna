import { describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.KORTIX_APPS_BASE_DOMAIN = 'apps.dosco.live';

const { fetchWithRecovery } = await import('./public-proxy-recovery');

const E2B_TOKEN_403 =
  'Sandbox is secured with traffic access token.\nToken header `e2b-traffic-access-token` is missing.';

function e2bTokenFailure(): Response {
  return new Response(E2B_TOKEN_403, { status: 403 });
}

const starting = () => Promise.resolve(new Response('starting', { status: 503 }));

describe('App proxy provider-token recovery', () => {
  test('a replayable GET retries once after the E2B token failure', async () => {
    let calls = 0;
    let invalidations = 0;
    const result = await fetchWithRecovery(
      async () => {
        calls += 1;
        return calls === 1 ? e2bTokenFailure() : new Response('app', { status: 200 });
      },
      async () => {},
      starting,
      () => 'e2b',
      () => {
        invalidations += 1;
      },
      true,
      false,
    );

    expect(calls).toBe(2);
    expect(invalidations).toBe(1);
    expect(result.upstream?.status).toBe(200);
    expect(result.starting).toBeUndefined();
  });

  test('a write is not replayed after the E2B token failure', async () => {
    let calls = 0;
    let invalidations = 0;
    const result = await fetchWithRecovery(
      async () => {
        calls += 1;
        return e2bTokenFailure();
      },
      async () => {},
      starting,
      () => 'e2b',
      () => {
        invalidations += 1;
      },
      false,
      false,
    );

    expect(calls).toBe(1);
    expect(invalidations).toBe(1);
    expect(result.upstream?.status).toBe(403);
  });

  test('an App 403 is passed through without a retry', async () => {
    let calls = 0;
    let invalidations = 0;
    const result = await fetchWithRecovery(
      async () => {
        calls += 1;
        return new Response('forbidden: the app itself said no', { status: 403 });
      },
      async () => {},
      starting,
      () => 'e2b',
      () => {
        invalidations += 1;
      },
      true,
      false,
    );

    expect(calls).toBe(1);
    expect(invalidations).toBe(0);
    expect(result.upstream?.status).toBe(403);
    expect(await result.upstream?.text()).toBe('forbidden: the app itself said no');
  });

  test('a second E2B token failure is not retried again', async () => {
    let calls = 0;
    let invalidations = 0;
    const result = await fetchWithRecovery(
      async () => {
        calls += 1;
        return e2bTokenFailure();
      },
      async () => {},
      starting,
      () => 'e2b',
      () => {
        invalidations += 1;
      },
      true,
      false,
    );

    expect(calls).toBe(2);
    expect(invalidations).toBe(1);
    expect(result.upstream?.status).toBe(403);
  });
});
