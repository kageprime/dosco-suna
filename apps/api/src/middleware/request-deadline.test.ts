import { describe, expect, test } from 'bun:test';
import { isExempt, requestDeadlineMs } from './request-deadline';

function ctx(path: string, method = 'POST') {
  return {
    req: {
      header: () => undefined,
      path,
      method,
    },
  } as never;
}

describe('requestDeadline exemptions', () => {
  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/install',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/install',
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/update',
    '/v1/projects/00000000-0000-4000-a000-000000000001/marketplace/update-all',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry/update',
  ])('exempts install/update route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  // The MCP server bounds itself at 55 s (mcp/index.ts REQUEST_BUDGET_MS):
  // read_session waits and run_command runs up to 45 s. A client that sends
  // only `Accept: application/json` gets no event-stream exemption.
  test('exempts the MCP endpoint, whatever the client accepts', () => {
    expect(isExempt(ctx('/v1/mcp'))).toBe(true);
  });

  test.each([
    '/v1/marketplace/items',
    '/v1/projects/00000000-0000-4000-a000-000000000001/registry',
  ])('does not exempt bounded route %s', (path) => {
    expect(isExempt(ctx(path))).toBe(false);
  });

  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/commit-push',
    '/v1/projects/00000000-0000-4000-a000-000000000001/provision',
  ])('leaves existing exemption %s unchanged', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  // KRTX-4615: the daemon's config-release descriptor tick (the 60 s
  // runtime-truth poll). Its cold build is git-bound (mirror fetch, tree
  // reads, archive tar+gzip — each op bounded by its own 30–60 s timeout),
  // and the client aborts at 20 s: the 25 s guard only 503'd work that
  // finished and cached anyway. The legacy `/v1/workspaces` spelling must
  // exempt identically (`asLegacyWorkspaceRoute`).
  test.each([
    '/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/config-release',
    '/v1/workspaces/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/config-release',
  ])('exempts the config-release descriptor tick %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  // The exemption is method+path anchored, not a `path.includes()` fragment:
  // a fragment would also sweep up the agent-config read of an agent named
  // `config-release`, a GET on the descriptor path, and deeper child paths.
  test('still bounds the config etag read, which the fragment must not sweep up', () => {
    expect(
      isExempt(ctx('/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/config', 'GET')),
    ).toBe(false);
  });

  test('still bounds an agent named config-release and every non-tick config-release path', () => {
    for (const [path, method] of [
      // The agent-config route shape (agent-config.ts): agentName=config-release.
      ['/v1/projects/00000000-0000-4000-a000-000000000001/agents/config-release/config', 'GET'],
      // Only the daemon's POST tick is exempt, never a GET on the same path.
      ['/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/config-release', 'GET'],
      // A deeper child path keeps the deadline too (the pattern anchors at $).
      ['/v1/projects/00000000-0000-4000-a000-000000000001/sessions/00000000-0000-4000-a000-000000000002/config-release/config', 'POST'],
    ] as const) {
      expect(isExempt(ctx(path, method))).toBe(false);
      expect(requestDeadlineMs(ctx(path, method))).not.toBeNull();
    }
  });
});

/**
 * The streaming secret relay must NOT be bounded by the 25 s deadline.
 *
 * This is one of two edits that are easy to forget and fail almost silently:
 * without the exemption every relay over 25 s dies with a 503
 * `request_deadline` (the sibling edit is `server.timeout(req, 0)` in index.ts,
 * without which Bun cuts the socket with an empty reply the LB turns into a
 * CORS-less 502). `/v1/projects` is not an exempt PREFIX, so nothing else here
 * covers these routes.
 */
describe('requestDeadline exempts the streaming secret relay', () => {
  const project = '/v1/projects/00000000-0000-4000-a000-000000000001';

  test.each([
    `${project}/secrets/STRIPE_KEY/relay`,
    `${project}/secrets/STRIPE_KEY/relay/ws-ticket`,
  ])('exempts %s', (path) => {
    expect(isExempt(ctx(path))).toBe(true);
  });

  test('still bounds the buffered broker route, which cannot stream', () => {
    // /broker is capped at 1 MiB / 5 MiB and answers in one shot, so it has no
    // business outliving the deadline.
    expect(isExempt(ctx(`${project}/secrets/STRIPE_KEY/broker`))).toBe(false);
  });

  test('the fragment is specific enough not to catch unrelated routes', () => {
    // `EXEMPT_FRAGMENTS` matches with `path.includes()`, so a fragment that is
    // too generic silently un-bounds half the API.
    for (const path of [
      `${project}/secrets`,
      `${project}/sessions/session-1`,
      '/v1/accounts/relayed-billing',
    ]) {
      expect(isExempt(ctx(path))).toBe(false);
    }
  });
});

/**
 * Attachment completion verifies up to 50 MiB under its own 85 s Storage bound
 * (`COMPLETE_BOUND_MS`). The general deadline (25 s; 55 s on staging) would
 * answer 503 while that verify still runs, and the SDK retry would start a
 * second one. Completion is not exempt either: a longer deadline bounds the
 * whole request, database waits included. It answers before Cloudflare's 100 s
 * proxy timeout, so the client never gets a 524 and re-downloads the object.
 */
describe('attachment completion has its own request deadline', () => {
  const project = '/v1/projects/00000000-0000-4000-a000-000000000001';

  test('POST complete is bounded at 95 s, under the 100 s Cloudflare proxy timeout', () => {
    const complete = ctx(`${project}/attachments/attachment-1/complete`);
    expect(isExempt(complete)).toBe(false);
    expect(requestDeadlineMs(complete)).toBe(95_000);
    expect(requestDeadlineMs(complete)!).toBeLessThan(100_000);
  });

  test('the other attachment routes keep the general deadline', () => {
    const general = requestDeadlineMs(ctx('/v1/marketplace/items', 'GET'));
    expect(general).toBeGreaterThan(0);
    for (const [path, method] of [
      [`${project}/attachments`, 'POST'],
      [`${project}/attachments/attachment-1/chunks/0`, 'PUT'],
      [`${project}/attachments/attachment-1`, 'DELETE'],
      [`${project}/attachments/attachment-1/complete`, 'GET'],
      [`${project}/attachments/attachment-1/complete/extra`, 'POST'],
    ] as const) {
      expect(isExempt(ctx(path, method))).toBe(false);
      expect(requestDeadlineMs(ctx(path, method))).toBe(general);
    }
  });

  test('an exempt route has no deadline', () => {
    expect(requestDeadlineMs(ctx(`${project}/provision`))).toBeNull();
  });

  test('P2.13: the session-log attachment upload (PUT …/log/blobs/<sha256>) gets 95 s; its lookup keeps the general deadline', () => {
    const blob = `${project}/sessions/00000000-0000-4000-a000-000000000002/log/blobs/${'a'.repeat(64)}`;
    expect(requestDeadlineMs(ctx(blob, 'PUT'))).toBe(95_000);
    const general = requestDeadlineMs(ctx('/v1/marketplace/items', 'GET'));
    expect(requestDeadlineMs(ctx(blob, 'GET'))).toBe(general);
    expect(requestDeadlineMs(ctx(`${blob}/extra`, 'PUT'))).toBe(general);
  });
});

/**
 * KRTX-4738: an App machine exec (`POST …/apps/:appId/exec`) runs one command
 * under the caller's own timeout (`timeout_s` 1–300, default 60; the provider
 * call aborts at `timeoutMs + 30 s`, and the SDK client waits 120 s), but the
 * general 25 s deadline killed every exec that outlived it — prod: 4 execs
 * against a machine that had just restarted each died at exactly 25 s while
 * their siblings answered 178 ms–17.9 s. The route gets the same 95 s
 * completion deadline as attachment completion: it answers before Cloudflare's
 * 100 s proxy timeout and still bounds database waits. It is not exempt.
 */
describe('App machine exec has the 95 s completion deadline', () => {
  const project = '/v1/projects/00000000-0000-4000-a000-000000000001';
  const workspace = '/v1/workspaces/00000000-0000-4000-a000-000000000001';

  test('POST exec is bounded at 95 s, under the 100 s Cloudflare proxy timeout', () => {
    const exec = ctx(`${project}/apps/00000000-0000-4000-a000-000000000003/exec`);
    expect(isExempt(exec)).toBe(false);
    expect(requestDeadlineMs(exec)).toBe(95_000);
  });

  test('the /v1/workspaces alias gets the same 95 s deadline', () => {
    expect(requestDeadlineMs(ctx(`${workspace}/apps/00000000-0000-4000-a000-000000000003/exec`))).toBe(95_000);
  });

  test('the anchoring is exact: other methods and paths keep the general deadline', () => {
    const general = requestDeadlineMs(ctx('/v1/marketplace/items', 'GET'));
    for (const [path, method] of [
      [`${project}/apps/00000000-0000-4000-a000-000000000003/exec`, 'GET'],
      [`${project}/apps/00000000-0000-4000-a000-000000000003/exec/extra`, 'POST'],
      [`${project}/apps/00000000-0000-4000-a000-000000000003/machines`, 'POST'],
    ] as const) {
      expect(isExempt(ctx(path, method))).toBe(false);
      expect(requestDeadlineMs(ctx(path, method))).toBe(general);
    }
  });
});
