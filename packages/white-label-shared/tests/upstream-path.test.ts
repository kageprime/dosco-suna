import { describe, expect, test } from 'bun:test';
import { buildUpstreamPath } from '../src/upstream-path';

const OWN = '00000000-0000-4000-8000-000000000001';
const VICTIM = '00000000-0000-4000-8000-000000000002';

describe('buildUpstreamPath', () => {
  test('an ordinary path passes through unchanged', () => {
    expect(buildUpstreamPath(['projects', OWN, 'secrets'])).toEqual({
      ok: true,
      path: `projects/${OWN}/secrets`,
    });
  });

  test('THE HOLE: an encoded slash smuggling a traversal is refused', () => {
    // Next decodes `%2F..%2F` into the segment `<own>/../<victim>/secrets`.
    // Joined, the policy sees "a route under <own>" (which the caller owns) and
    // the upstream resolves it to <victim>. This returned 200 with another
    // tenant's secret VALUE before the guard existed.
    const result = buildUpstreamPath(['projects', `${OWN}/../${VICTIM}/secrets`]);
    expect(result.ok).toBe(false);
  });

  test('the traversal-tail variant is refused too', () => {
    expect(buildUpstreamPath(['projects', `${OWN}/../${VICTIM}`, 'secrets']).ok).toBe(false);
  });

  test('escaping the project prefix entirely is refused', () => {
    // `/api/kortix/projects/<own>%2F..%2F..%2Faccounts%2Fme` reached
    // /v1/accounts/me — an account-admin surface the policy blocks outright.
    expect(buildUpstreamPath(['projects', `${OWN}/../../accounts/me`]).ok).toBe(false);
  });

  test('a bare .. segment is refused even without an encoded slash', () => {
    expect(buildUpstreamPath(['projects', OWN, '..', VICTIM, 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', '.', OWN]).ok).toBe(false);
  });

  test('a dot segment that is still percent-encoded is refused', () => {
    // `%252e%252e` arrives from Next as the segment `%2e%2e`. fetch() resolves
    // it as `..`, so the policy would approve <own> and the upstream would get
    // <victim>, or /v1/accounts.
    expect(buildUpstreamPath(['projects', OWN, '%2e%2e', VICTIM, 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', OWN, '%2E%2E', '%2e%2e', 'accounts']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', OWN, 'a?b']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', OWN, 'a#b']).ok).toBe(false);
  });

  test('a backslash cannot stand in for the slash', () => {
    expect(buildUpstreamPath(['projects', `${OWN}\\..\\${VICTIM}`]).ok).toBe(false);
  });

  test('an empty segment is refused rather than collapsed', () => {
    // `projects//secrets` would let the policy's `[^/]+` capture an empty id.
    expect(buildUpstreamPath(['projects', '', 'secrets']).ok).toBe(false);
  });

  test('a control character is refused', () => {
    expect(buildUpstreamPath(['projects', `${OWN}\u0000`, 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', `${OWN}
`, 'secrets']).ok).toBe(false);
  });

  test('a decoded ? # or % is refused: the upstream URL would end or re-decode there', () => {
    // `%3F` decodes to `?`: the policy sees `p/share?/8000/kortix/health`, the upstream `p/share`.
    expect(buildUpstreamPath(['p', 'share?', '8000', 'kortix', 'health']).ok).toBe(false);
    expect(buildUpstreamPath(['p', 'config#', '8000', 'kortix', 'health']).ok).toBe(false);
    // `%252e%252e` decodes to `%2e%2e`, which the URL parser resolves as `..`.
    expect(buildUpstreamPath(['projects', '%2e%2e', 'secrets']).ok).toBe(false);
    expect(buildUpstreamPath(['projects', OWN, '.%2e', 'secrets']).ok).toBe(false);
  });

  test('legitimate paths with dots, dashes and spaces still work', () => {
    // A guard that also breaks ordinary traffic is a worse bug than the hole.
    expect(buildUpstreamPath(['projects', OWN, 'files', 'src', 'index.test.ts']).ok).toBe(true);
    expect(buildUpstreamPath(['p', 'sb_123', '3000', 'index.html']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'secrets', 'MY SECRET']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'files', '.gitignore']).ok).toBe(true);
    expect(buildUpstreamPath(['projects', OWN, 'files', '..hidden']).ok).toBe(true);
  });
});

describe('buildUpstreamPath: canonical workspace names', () => {
  // The SDK calls the canonical `/v1/workspaces` names. The proxy turns each
  // into the legacy name it has always judged, and forwards that same string:
  // the policy and the upstream never see two different routes. The API
  // serves every legacy name permanently, on old and new deployments.
  test.each([
    [['workspaces'], 'projects'],
    [['workspaces', 'provision'], 'projects/provision'],
    [['workspaces', OWN, 'sessions', 's1', 'start'], `projects/${OWN}/sessions/s1/start`],
    [['workspaces', OWN, 'members'], `accounts/${OWN}/members`],
    [['workspaces', OWN, 'iam', 'groups'], `accounts/${OWN}/iam/groups`],
    [['me'], 'accounts/me'],
    [['me', 'devices'], 'accounts/me/devices'],
    [['invites', 'i1', 'accept'], 'account-invites/i1/accept'],
    [['connectors', 'workspaces', OWN, 'connectors'], `connectors/projects/${OWN}/connectors`],
    [['projects', OWN, 'secrets'], `projects/${OWN}/secrets`],
    [['p', 'ext', '8000', 'v1', 'me'], 'p/ext/8000/v1/me'],
    [['memberships'], 'memberships'],
    // Characterization (KRTX-4847): the names the proxy forwards, pinned before
    // the map moved to `@kortix/shared/workspace-routes`.
    [['workspaces', OWN, 'sessions'], `projects/${OWN}/sessions`],
    [['workspaces', OWN, 'sessions', 's1', 'audit'], `projects/${OWN}/sessions/s1/audit`],
    [
      ['workspaces', OWN, 'sessions', 's1', 'audit', 'events'],
      `projects/${OWN}/sessions/s1/audit/events`,
    ],
    [['workspaces', OWN, 'secrets'], `projects/${OWN}/secrets`],
    [['workspaces', OWN, 'audit'], `accounts/${OWN}/audit`],
    [['workspaces', OWN, 'audit', 'export'], `accounts/${OWN}/audit/export`],
    [['workspaces', OWN, 'automations'], `accounts/${OWN}/automations`],
    [['workspaces', OWN, 'branding'], `accounts/${OWN}/branding`],
    [['workspaces', OWN, 'capture'], `accounts/${OWN}/capture`],
    [
      ['workspaces', OWN, 'iam', 'members', 'u1', 'effective'],
      `accounts/${OWN}/iam/members/u1/effective`,
    ],
    [['workspaces', OWN, 'invites'], `accounts/${OWN}/invites`],
    [['workspaces', OWN, 'leave'], `accounts/${OWN}/leave`],
    [['workspaces', OWN, 'secret-resources'], `accounts/${OWN}/secret-resources`],
    [['workspaces', OWN, 'subscription-connections'], `accounts/${OWN}/subscription-connections`],
    [['workspaces', OWN, 'tokens'], `accounts/${OWN}/tokens`],
    [['workspaces', OWN, 'top-up-requests'], `accounts/${OWN}/top-up-requests`],
    [['invites'], 'account-invites'],
    [['workspacesx'], 'workspacesx'],
    [['mex'], 'mex'],
    [['invitesx'], 'invitesx'],
    [['connectors', 'workspaces'], 'connectors/workspaces'],
    [['connectors', 'projects', OWN, 'connectors'], `connectors/projects/${OWN}/connectors`],
    [['scim', 'v2', 'workspaces', OWN, 'Users'], `scim/v2/workspaces/${OWN}/Users`],
  ])('%j → %s', (segments, path) => {
    expect(buildUpstreamPath(segments)).toEqual({ ok: true, path });
  });
});

describe('buildUpstreamPath: the map is the one @kortix/shared/workspace-routes owns', () => {
  // The white-label copies of the map lacked three cases of the canonical one.
  // The SDK's project audit client calls `GET /v1/workspaces/:id/audit/events`;
  // the API serves it as `/v1/projects/:id/audit`, and mounts no
  // `/v1/accounts/:id/audit/events`.
  test.each([
    [['workspaces', OWN, 'audit', 'events'], `projects/${OWN}/audit`],
    [['workspaces', OWN, 'keys'], `accounts/${OWN}/keys`],
    [['webhooks', 'workspaces', OWN, 'w1'], `webhooks/projects/${OWN}/w1`],
  ])('%j → %s', (segments, path) => {
    expect(buildUpstreamPath(segments)).toEqual({ ok: true, path });
  });
});
