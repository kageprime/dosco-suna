/**
 * KRTX-4446: the `[connector] <path> failed (upstream …)` warn is rate-limited.
 * An upstream outage plus one agent repeating the failed call every few
 * seconds used to log one warn per attempt — prod, 2026-11-07: 28 warns in one
 * hour for `linear.run_query_or_mutation` against a baseline of about one per
 * hour, and it read as a new log-pattern anomaly. KRTX-614 learning ("rate
 * limit the warning for expected backpressure"): the first failure of a call
 * path always warns, then at most one per interval.
 *
 * Pure unit test: every gateway dep is faked, the logger is mocked (the real
 * one ships to Better Stack), and the clock is fake. No PostgreSQL.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';

const warns: string[] = [];
mock.module('../lib/logger', () => ({
  logger: { debug() {}, info() {}, error() {}, warn: (message: string) => warns.push(message) },
}));

import { type GatewayDeps, handleCall } from './gateway';

function deps(actionPath: string): GatewayDeps {
  return {
    loadConnectorBySlug: async () => ({
      connectorId: 'conn-linear',
      slug: 'linear',
      provider: 'http',
      baseUrl: 'https://linear.example',
      auth: { type: 'bearer', in: 'header', name: null, prefix: null },
      hasAuth: true,
      credentialMode: 'shared',
      enabled: true,
    }),
    loadAction: async () => ({
      path: `linear.${actionPath}`,
      relPath: actionPath,
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      binding: { kind: 'http', method: 'POST', path: '/actions' },
    }),
    resolveCredential: async () => 'synthetic-credential',
    loadPolicies: async () => [],
    recordExecution: async () => 'exec-1',
    // The upstream answers the way a provider outage does: a 502 with a body.
    fetchImpl: async () => ({ status: 502, ok: false, text: async () => 'bad gateway' }),
  };
}

const call = (actionPath: string) =>
  handleCall(deps(actionPath), {
    projectId: 'project-fake',
    accountId: 'account-fake',
    subject: { userId: 'user-fake', groupIds: [] },
    connectorSlug: 'linear',
    actionPath,
    args: {},
  });

let clock = 1_700_000_000_000;

/** Date.now is the throttle's clock; a spun clock keeps the test off real time. */
function useFakeClock(): () => void {
  const spy = spyOn(Date, 'now').mockImplementation(() => clock);
  return () => spy.mockRestore();
}

let restore = () => {};

afterEach(() => {
  restore();
  // A new test starts with an empty window, so test order cannot hide a
  // failure: a stale throttle entry would wrongly suppress the next first warn.
  warns.length = 0;
});

test('the first failure warns, repeats inside the interval stay silent, one after it warns again', async () => {
  restore = useFakeClock();
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain('[connector] linear.run_query_or_mutation failed (upstream 502)');

  // A repeated call ten seconds later is the same failure already reported.
  clock += 10_000;
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(1);

  // Past the interval the failure warns again — the pattern never goes darker
  // than one line per call path per interval.
  clock += 61_000;
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(2);
});

test('a second failing call path warns independently inside the same interval', async () => {
  clock += 300_000; // step past every window the earlier test opened
  restore = useFakeClock();
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  expect(await call('get_linear_issue')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(2); // one per call path, not one per interval overall
});
