import { describe, expect, test } from 'bun:test';
import {
  type AdminConnectorCandidate,
  buildAdminConnectorViews,
  signedInComposioSlugs,
  safeConnectorLastError,
} from './connector-list';

describe('buildAdminConnectorViews', () => {
  test('maps preloaded credential state without connector-local reads', () => {
    const candidates = ['one', 'two'].map((slug) => ({
      slug,
      name: slug,
      provider: 'pipedream',
      platform: null,
      iconUrl: null,
      status: 'active',
      authorizationStrategy: slug === 'one' ? ('project' as const) : ('user' as const),
      sensitive: false,
      actions: [],
      requiresAuth: true,
      requestAuthType: slug === 'one' ? ('hmac' as const) : ('bearer' as const),
      secretIdentifier: slug === 'one' ? 'SIGNING_KEY' : null,
      credentialSource: slug === 'one' ? ('project_secret' as const) : ('stored' as const),
    }));

    const result = buildAdminConnectorViews(candidates, new Set(['two']));

    expect(result.map((connector) => connector.secretSet)).toEqual([false, true]);
    expect(result.map((connector) => connector.authorizationStrategy)).toEqual(['project', 'user']);
    expect(result.map((connector) => connector.requestAuthType)).toEqual(['hmac', 'bearer']);
    expect(result.map((connector) => connector.secretIdentifier)).toEqual(['SIGNING_KEY', null]);
    expect(result.map((connector) => connector.credentialSource)).toEqual([
      'project_secret',
      'stored',
    ]);
  });
});

const candidate = (overrides: Partial<AdminConnectorCandidate> = {}): AdminConnectorCandidate => ({
  slug: 'weather',
  name: 'Weather',
  provider: 'openapi',
  platform: null,
  iconUrl: null,
  status: 'error',
  authorizationStrategy: 'project',
  sensitive: false,
  actions: [],
  requiresAuth: false,
  requestAuthType: 'none',
  secretIdentifier: null,
  credentialSource: 'none',
  ...overrides,
});

describe('buildAdminConnectorViews lastError', () => {
  test('passes the stored reason through', () => {
    const [view] = buildAdminConnectorViews(
      [candidate({ lastError: 'MCP tools/list failed: HTTP 401' })],
      new Set(),
    );
    expect(view?.lastError).toBe('MCP tools/list failed: HTTP 401');
  });

  test('defaults to null when the row has no reason', () => {
    const views = buildAdminConnectorViews(
      [candidate({ status: 'active' }), candidate({ status: 'active', lastError: null })],
      new Set(),
    );
    expect(views.map((view) => view.lastError)).toEqual([null, null]);
    expect(views.every((view) => 'lastError' in view)).toBe(true);
  });

  test('never returns a secret the stored text carried', () => {
    const [view] = buildAdminConnectorViews(
      [
        candidate({
          lastError:
            'failed to fetch spec at https://api.example.test/openapi.json?api_key=synthetic-key-123: HTTP 401 Unauthorized',
        }),
      ],
      new Set(),
    );
    expect(view?.lastError).not.toContain('synthetic-key-123');
  });
});

describe('safeConnectorLastError', () => {
  test('null, undefined and blank text are null', () => {
    expect(safeConnectorLastError(null)).toBeNull();
    expect(safeConnectorLastError(undefined)).toBeNull();
    expect(safeConnectorLastError('  \n ')).toBeNull();
  });

  test('the reasons the MCP path already writes are returned unchanged', () => {
    for (const reason of [
      'MCP tools/list failed: HTTP 401',
      'MCP tools/list failed: transport error',
      'MCP tools/list failed: JSON-RPC -32600 invalid request',
      'MCP catalog credential resolution failed: OAuth2 token request failed (401): invalid_client',
      'MCP catalog credential resolution failed: OAuth2 token response has no access_token',
      'connector spec not found in repository: specs/weather.yaml',
    ]) {
      expect(safeConnectorLastError(reason)).toBe(reason);
    }
  });

  test('drops a URL query and fragment, keeps the host and path', () => {
    expect(
      safeConnectorLastError(
        'failed to fetch spec at https://api.example.test/v1/openapi.json?api_key=synthetic-key-123&v=2#frag: HTTP 401 Unauthorized',
      ),
    ).toBe(
      'failed to fetch spec at https://api.example.test/v1/openapi.json?[REDACTED] HTTP 401 Unauthorized',
    );
  });

  test('drops credentials embedded in a URL', () => {
    expect(
      safeConnectorLastError(
        "fatal: unable to access 'https://x-access-token:synthetic-token-456@git.example.test/org/repo.git/': 403",
      ),
    ).toBe("fatal: unable to access 'https://[REDACTED]@git.example.test/org/repo.git/': 403");
  });

  test('drops bearer and basic values and named credential headers', () => {
    expect(safeConnectorLastError('upstream said: Authorization: Bearer synthetic.jwt-789')).toBe(
      'upstream said: Authorization: [REDACTED]',
    );
    expect(safeConnectorLastError('rejected Basic c3ludGhldGljOnBhc3M= for user')).toBe(
      'rejected Basic [REDACTED] for user',
    );
    expect(safeConnectorLastError('bad header x-api-key=synthetic-key-123, retry')).toBe(
      'bad header x-api-key=[REDACTED], retry',
    );
  });

  test('flattens control characters and caps the length', () => {
    expect(safeConnectorLastError('line one\r\n\tline two')).toBe('line one line two');
    const long = safeConnectorLastError('x'.repeat(5_000));
    expect(long).toHaveLength(300);
    expect(long?.endsWith('…')).toBe(true);
  });
});

describe('buildAdminConnectorViews state', () => {
  test('one derived state: disabled, error, needs_account or connected, with auth_needed', () => {
    const views = buildAdminConnectorViews(
      [
        candidate({ slug: 'off', status: 'disabled' }),
        candidate({ slug: 'broken', status: 'error', lastError: 'MCP tools/list failed: HTTP 500' }),
        candidate({ slug: 'gmail', status: 'needs_auth', requiresAuth: true }),
        candidate({ slug: 'linear', status: 'active', requiresAuth: true }),
        candidate({ slug: 'wiki', status: 'active', requiresAuth: false }),
        candidate({ slug: 'mcp-oauth', status: 'error', lastError: 'HTTP 401', requiresAuth: true }),
      ],
      new Set(['linear']),
    );
    expect(views.map((v) => [v.slug, v.state, v.state_reason, v.auth_needed])).toEqual([
      ['off', 'disabled', 'disabled in kortix.yaml', false],
      ['broken', 'error', 'MCP tools/list failed: HTTP 500', false],
      ['gmail', 'needs_account', 'no account connected', true],
      ['linear', 'connected', null, true],
      ['wiki', 'connected', null, false],
      // No tools without a sign-in: the fix is an account, not a repair.
      ['mcp-oauth', 'needs_account', 'no account connected', true],
    ]);
  });
});

describe('buildAdminConnectorViews error without a reason', () => {
  const account = { connection_id: 'conn-synthetic', label: 'default', owner_type: 'project', is_default: true };

  test('no account and no stored reason: needs_account, never a bare error', () => {
    const [view] = buildAdminConnectorViews([candidate({ slug: 'edge', status: 'error', lastError: null, accounts: [] })], new Set());
    expect([view?.state, view?.state_reason, view?.lastError]).toEqual(['needs_account', 'no account connected', null]);
  });

  test('a stored reason that sanitizes to nothing counts as no reason', () => {
    const [view] = buildAdminConnectorViews([candidate({ slug: 'edge', status: 'error', lastError: ' \u0000 ' })], new Set());
    expect(view?.state).toBe('needs_account');
  });

  test('a failed call with a reason stays error, with the sanitized reason', () => {
    const [view] = buildAdminConnectorViews(
      [candidate({ slug: 'edge', status: 'error', lastError: 'HTTP 500 at https://u:p@mcp.example/x?token=t', accounts: [account] })],
      new Set(),
    );
    expect(view?.state).toBe('error');
    expect(view?.state_reason).toBe('HTTP 500 at https://[REDACTED]@mcp.example/x?[REDACTED]');
    expect(view?.lastError).toBe(view?.state_reason);
  });

  test('an account but no stored reason stays error with the fallback reason', () => {
    const [view] = buildAdminConnectorViews([candidate({ slug: 'edge', status: 'error', lastError: null, accounts: [account] })], new Set());
    expect([view?.state, view?.state_reason]).toEqual(['error', 'its tools could not be loaded']);
  });

  test('a recovered connector clears both', () => {
    const [view] = buildAdminConnectorViews([candidate({ slug: 'edge', status: 'active', lastError: null, accounts: [account] })], new Set());
    expect([view?.state, view?.state_reason, view?.lastError]).toEqual(['connected', null, null]);
  });
});

describe('signedInComposioSlugs', () => {
  test('a Composio connector counts as connected only with a signed-in account, as the gateway decides', () => {
    const rows = [
      { slug: 'gmail', connectorId: 'c-gmail' }, // the sync-created default row, never authorized
      { slug: 'github', connectorId: 'c-github' },
      { slug: 'hackernews', connectorId: 'c-hn' },
      { slug: 'slack', connectorId: 'c-none' },
    ];
    const entitled = new Map([
      ['c-gmail', [{ metadata: { provider: 'composio', toolkit: 'gmail' } }]],
      ['c-github', [{ metadata: { provider: 'composio', connected_account_id: 'ca_1' } }]],
      ['c-hn', [{ metadata: { provider: 'composio', is_no_auth: true } }]],
    ]);
    expect([...signedInComposioSlugs(rows, entitled)]).toEqual(['github', 'hackernews']);
  });
});
