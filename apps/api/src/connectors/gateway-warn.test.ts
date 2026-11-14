/**
 * KRTX-4446: the `[connector] <path> failed (upstream …)` warn is rate-limited.
 * An upstream outage plus one agent repeating the failed call every few
 * seconds used to log one warn per attempt — prod, 2026-11-07: 28 warns in one
 * hour for `linear.run_query_or_mutation` against a baseline of about one per
 * hour, and it read as a new log-pattern anomaly. KRTX-614 learning ("rate
 * limit the warning for expected backpressure"): the first failure of a call
 * path always warns, then at most one per interval.
 *
 * KRTX-4759: the same warn carries no per-call identifier. The message embeds
 * the call path, so one provider-side failure class (a Composio-edge WAF block
 * hit `linear.run_query_or_mutation`, `linear.create_linear_comment` and
 * `linear.update_linear_comment` for a week) hashed to one log-pattern key per
 * action and filed a new Linear issue per action variant. The message is now
 * identical for every call path; the path rides in the `connector_action`
 * field the structured logger ships alongside it.
 *
 * Pure unit test: every gateway dep is faked, the logger is mocked (the real
 * one ships to Better Stack), and the clock is fake. No PostgreSQL.
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';

const warns: string[] = [];
const warnContexts: (Record<string, unknown> | undefined)[] = [];
mock.module('../lib/logger', () => ({
  logger: {
    debug() {},
    info() {},
    error() {},
    warn: (message: string, context?: Record<string, unknown>) => {
      warns.push(message);
      warnContexts.push(context);
    },
  },
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
  warnContexts.length = 0;
});

test('the first failure warns, repeats inside the interval stay silent, one after it warns again', async () => {
  restore = useFakeClock();
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(1);
  expect(warns[0]).toContain('[connector] call failed (upstream 502)');
  expect(warnContexts[0]).toEqual({ connector_action: 'linear.run_query_or_mutation' });

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

test('two failing call paths log the identical message; the path rides in connector_action (KRTX-4759)', async () => {
  clock += 300_000; // step past every window the earlier tests opened
  restore = useFakeClock();
  expect(await call('run_query_or_mutation')).toMatchObject({ status: 'error' });
  clock += 61_000; // past the throttle interval so the second path's warn is its own
  expect(await call('get_linear_issue')).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(2);
  // One failure class, one message shape: a per-call identifier in the text
  // splits one provider-side failure into one log-pattern key per call path.
  expect(warns[1]).toBe(warns[0]);
  expect(warns[0]).not.toContain('run_query_or_mutation');
  expect(warns[0]).not.toContain('get_linear_issue');
  // The structured field keeps the path queryable in Better Stack/ClickHouse.
  expect(warnContexts[0]).toEqual({ connector_action: 'linear.run_query_or_mutation' });
  expect(warnContexts[1]).toEqual({ connector_action: 'linear.get_linear_issue' });
});

/**
 * KRTX-4722 follow-up: a Composio-edge WAF block (403 with the edge's HTML page)
 * is deterministic. The same arguments are refused again, and the caller that
 * keeps sending the blocked payload (about 3 an hour in prod after the
 * 403 stopped the SDK retry) re-fired the 60 s warn each time against a
 * baseline of 1.71 an hour. The block warns once per hour per call path.
 */
const EDGE_BLOCK =
  'composio_upstream_unavailable: Composio answered 403 with an HTML error page (page: Attention Required! | Cloudflare): the edge refused the call before it reached the provider, so the tool did not run — the same arguments will be refused again.';

function composioDeps(actionPath: string, status: number, data: string): GatewayDeps {
  const base = deps(actionPath);
  return {
    ...base,
    loadConnectorBySlug: async () => ({
      connectorId: 'conn-linear',
      slug: 'linear',
      provider: 'composio',
      baseUrl: null,
      auth: { type: 'none', in: 'header', name: null, prefix: null },
      hasAuth: false,
      credentialMode: 'shared',
      enabled: true,
      connectionId: 'connection-fake',
    }),
    loadAction: async () => ({
      path: `linear.${actionPath}`,
      relPath: actionPath,
      inputSchema: { type: 'object', properties: {} },
      risk: 'read',
      binding: { kind: 'composio', toolkit: 'linear', toolSlug: 'LINEAR_RUN_QUERY_OR_MUTATION' },
    }),
    executeComposio: async () => ({ ok: false, status, data }),
  };
}

const callComposio = (actionPath: string, status: number, data: string) =>
  handleCall(composioDeps(actionPath, status, data), {
    projectId: 'project-fake',
    accountId: 'account-fake',
    subject: { userId: 'user-fake', groupIds: [] },
    connectorSlug: 'linear',
    actionPath,
    args: {},
  });

test('an edge-refused 403 warns once per hour per call path; a 502 outage on the same path still warns per minute', async () => {
  clock += 300_000;
  restore = useFakeClock();
  expect(await callComposio('run_query_or_mutation', 403, EDGE_BLOCK)).toMatchObject({ status: 'error' });
  expect(warns).toHaveLength(1);

  // The caller repeats the blocked payload past the 60 s interval, inside the hour.
  clock += 61_000;
  await callComposio('run_query_or_mutation', 403, EDGE_BLOCK);
  clock += 1_800_000;
  await callComposio('run_query_or_mutation', 403, EDGE_BLOCK);
  expect(warns).toHaveLength(1);

  // A real outage on the same path is a different failure class and keeps the
  // 60 s window: it must not be hidden behind the block's hour.
  await callComposio('run_query_or_mutation', 502, 'composio_upstream_unavailable: Composio answered 502');
  expect(warns).toHaveLength(2);

  // Past the hour the block warns again.
  clock += 3_600_000;
  await callComposio('run_query_or_mutation', 403, EDGE_BLOCK);
  expect(warns).toHaveLength(3);
});

test('a 403 that is not the edge block keeps the 60 s window', async () => {
  clock += 300_000;
  restore = useFakeClock();
  await callComposio('run_query_or_mutation', 403, 'upstream_403: forbidden');
  clock += 61_000;
  await callComposio('run_query_or_mutation', 403, 'upstream_403: forbidden');
  expect(warns).toHaveLength(2);
});
