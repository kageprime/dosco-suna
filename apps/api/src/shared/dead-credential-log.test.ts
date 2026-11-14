/** Regression coverage for best-effort dead-credential warning suppression.
 * Pending counts are emitted only when another refusal opens the next window;
 * quiet bursts, eviction and restart can lose counts. Auth audits and
 * request-completion logs remain the exact accounting surfaces.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

interface Logged {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}
const logged: Logged[] = [];
const record =
  (level: string) =>
  (message: string, context?: Record<string, unknown>): void => {
    logged.push({ level, message, context });
  };

mock.module('../lib/logger', () => ({
  logger: {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    localError: record('localError'),
    localWarn: record('localWarn'),
    flush: async (): Promise<void> => {},
  },
  isLoggingTransportError: () => false,
}));

const {
  DEAD_CREDENTIAL_BURST_SUPPRESSED,
  deadCredentialLogKey,
  isCredentialFenceDenial,
  isDeadCredential,
  isAgentGrantDenial,
  isAgentAccessDenial,
  markCredentialFenceDenial,
  markDeadCredential,
  markAgentGrantDenial,
  markAgentAccessDenial,
  PREVIEW_SANDBOX_DENIED_MESSAGE,
} = await import('./dead-credential-log');
const { logWindowDecision, logWindowWarnDecision, resetLogWindowsForTests } = await import('./log-window');
const { installHttpErrors } = await import('../http-errors');
const { buildDenialError } = await import('../iam/denial-message');
const { enforceTokenProjectScope } = await import('../middleware/auth-scope');

// What authorizeV2 / assertAgentGrantAllows throw for an agent session whose
// kortix_permissions lack the action: buildDenialError's typed 403, marked.
function agentScopeDenialLike(action = 'workspace.gateway.spend.read'): HTTPException {
  return buildDenialError(action, 'agent_scope_insufficient');
}

// What resolvePat throws for a dead credential: the typed deadCredential401
// body, marked. middleware/auth.test.ts pins that deadCredential401 itself
// marks; this file pins what the mark does at the error handler.
function deadCredential401Like(message = 'PAT not found or revoked'): HTTPException {
  const err = new HTTPException(401, {
    message,
    res: new Response(
      JSON.stringify({ error: true, message, status: 401, code: 'session_token_revoked' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });
  markDeadCredential(err);
  return err;
}

// What denyProjectAccess throws when an account's "Require MFA" policy
// denies an aal1 browser session: buildDenialError's typed 403, marked.
function appWithMfaDenial(): OpenAPIHono {
  const app = new OpenAPIHono();
  installHttpErrors(app);
  app.get('/v1/projects/:workspaceId/sessions', () => {
    throw buildDenialError('project.session.read', 'account_mfa_required');
  });
  return app;
}


describe('dead-credential exceptions are marked and throttled at the error handler', () => {
  // The route throws what resolvePat throws for a dead credential. Five
  // identical refusals must produce ONE line (suppressed 0 on the first
  // window) — five lines is the spike this throttles. The line ships at
  // INFO: steady lease churn after session stops is the designed state
  // (KRTX-4454), and a flat warn line re-trips the infra-sweep's
  // new-pattern detector on its 0 baseline forever. Only a window whose
  // suppressed count left the churn band escalates to warn.
  function appWithDeadCredentialThrow(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/projects/:projectId/turn-stream', () => {
      throw deadCredential401Like();
    });
    app.post('/v1/plain', () => {
      throw new HTTPException(401, { message: 'Invalid PAT' });
    });
    return app;
  }

  test('an unmarked 401 still logs one warn line per refusal', () => {
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) app.request('/v1/plain', { method: 'POST' });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
    for (const warn of warns) {
      expect(warn.message).toContain('-> 401 [HTTPException] Invalid PAT');
      expect(warn.context?.suppressed).toBeUndefined();
    }
  });

  test('five identical dead-credential refusals log one info line, carrying the response body verbatim (KRTX-4454)', async () => {
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/projects/p/turn-stream', { method: 'POST' });
      expect(res.status).toBe(401);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toEqual({
      error: true,
      message: 'PAT not found or revoked',
      status: 401,
      code: 'session_token_revoked',
    });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first refusal line');
    expect(first.message).toContain('-> 401 [HTTPException] PAT not found or revoked');
    expect(first.context?.suppressed).toBe(0);
    expect(first.context?.reason).toBe('PAT not found or revoked');
  });

  test('a window whose suppressed count left the churn band ships the next line at warn (KRTX-4454)', async () => {
    resetLogWindowsForTests();
    const path = '/v1/projects/p/turn-stream';
    const key = deadCredentialLogKey('POST', path, 401, 'PAT not found or revoked');
    // A burst in a window that already expired: one decision opens it, the
    // rest are suppressed and left pending.
    const past = Date.now() - 601_000;
    expect(logWindowDecision(key, past).log).toBe(true);
    for (let i = 0; i < DEAD_CREDENTIAL_BURST_SUPPRESSED; i += 1) {
      expect(logWindowDecision(key, past + 1_000).log).toBe(false);
    }
    // The handler opens the next window and must ship the pending volume at
    // warn — a caller ignoring the typed stop code is not the designed churn.
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    const res = await app.request(path, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(0);
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context?.suppressed).toBe(DEAD_CREDENTIAL_BURST_SUPPRESSED);
  });

  test('fifteen project paths share one refusal window', async () => {
    resetLogWindowsForTests();
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    for (let i = 0; i < 15; i += 1) {
      const projectId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const response = await app.request(`/v1/projects/${projectId}/turn-stream`, { method: 'POST' });
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('session_token_revoked');
    }
    expect(logged.slice(before).filter((entry) => entry.level === 'info')).toHaveLength(1);
    expect(logged.slice(before).filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });

  test('refusals naming different revoked tokens share one window (KRTX-1564)', async () => {
    // The named refusal carries the dead row's id in the message. The throttle
    // key must normalize it out — otherwise every revoked token shards its own
    // bucket and the KRTX-1039 burst protection stops bounding the warn lines.
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/projects/:projectId/turn-stream', () => {
      throw deadCredential401Like(`project token ${crypto.randomUUID()} is revoked`);
    });
    const before = logged.length;
    for (let i = 0; i < 15; i += 1) {
      const res = await app.request('/v1/projects/p/turn-stream', { method: 'POST' });
      expect(res.status).toBe(401);
    }
    expect(logged.slice(before).filter((entry) => entry.level === 'info')).toHaveLength(1);
  });
});

describe('invalid or expired token warn is throttled at the error handler (KRTX-4442)', () => {
  // The route throws what resolveJwt throws for a JWT that failed verification.
  // Five identical refusals from one client retrying must produce ONE warn
  // line — the prod burst was 78 lines in one hour on GET /v1/auth/user —
  // while the response body keeps its global shape with no
  // session_token_revoked code: an expired JWT can come back via refresh.
  function appWithExpiredTokenThrow(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/auth/user', () => {
      throw new HTTPException(401, { message: 'Invalid or expired token' });
    });
    return app;
  }

  test('the first refusal logs one info line; repeats inside the window are suppressed and the body is untouched', async () => {
    resetLogWindowsForTests();
    const app = appWithExpiredTokenThrow();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/auth/user');
      expect(res.status).toBe(401);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toEqual({
      error: true,
      message: 'Invalid or expired token',
      status: 401,
    });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain('-> 401 [HTTPException] Invalid or expired token');
    expect(infos[0]?.context?.suppressed).toBe(0);
  });

  test('a 401 with a different reason still logs one warn per refusal', async () => {
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/auth/user', () => {
      throw new HTTPException(401, { message: 'Missing bearer token' });
    });
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request('/v1/auth/user');
      expect(res.status).toBe(401);
    }
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
    for (const warn of warns) {
      expect(warn.message).toContain('-> 401 [HTTPException] Missing bearer token');
      expect(warn.context?.suppressed).toBeUndefined();
    }
  });
});

test('marking is what routes the line through the throttle', () => {
  const plain = new HTTPException(401, { message: 'Invalid PAT' });
  const marked = new HTTPException(401, { message: 'PAT not found or revoked' });
  markDeadCredential(marked);
  expect(isDeadCredential(marked)).toBe(true);
  expect(isDeadCredential(plain)).toBe(false);
});

describe('agent-grant denial warns are throttled at the error handler (KRTX-4635)', () => {
  // The route throws what authorizeV2 / assertAgentGrantAllows throw when the
  // requesting agent session's kortix_permissions lack the action. A caller
  // that never reads the typed body — an in-sandbox agent looping a denied
  // command — turns every refusal into a warn line: one prod lane put 590
  // lines in two hours on one route (KRTX-4635). The mark routes the LINE
  // through the same per-route window throttle without touching the typed
  // 403 response, exactly as KRTX-1039 did for dead credentials.
  function appWithAgentGrantDenial(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/workspaces/:workspaceId/gateway/sources', () => {
      throw agentScopeDenialLike();
    });
    app.get('/v1/workspaces/:workspaceId/audit', () => {
      // A 403 outside the agent-grant family: its constraint is not a stable
      // principal property, so its line stays per-request.
      throw buildDenialError('workspace.audit.read', 'sso_required');
    });
    return app;
  }

  test('five identical denials log one info line; the typed 403 body ships every time', async () => {
    resetLogWindowsForTests();
    const app = appWithAgentGrantDenial();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/workspaces/w/gateway/sources');
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toMatchObject({ error: true, status: 403, code: 'agent_scope_insufficient' });
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first denial line');
    expect(first.message).toContain('-> 403 [HTTPException] This agent session is not granted');
    expect(first.context?.suppressed).toBe(0);
  });

  test('a window whose suppressed count left the churn band ships the next line at warn', async () => {
    resetLogWindowsForTests();
    const path = '/v1/workspaces/w/gateway/sources';
    const reason = agentScopeDenialLike().message ?? '';
    const key = deadCredentialLogKey('GET', path, 403, reason);
    // A burst in a window that already expired: one decision opens it, the
    // rest are suppressed and left pending.
    const past = Date.now() - 601_000;
    expect(logWindowDecision(key, past).log).toBe(true);
    for (let i = 0; i < DEAD_CREDENTIAL_BURST_SUPPRESSED; i += 1) {
      expect(logWindowDecision(key, past + 1_000).log).toBe(false);
    }
    // The handler opens the next window and must ship the pending volume at
    // warn — an agent loop grinding on a denial it never acts on is not the
    // designed churn (KRTX-4454's severity follows the volume).
    const app = appWithAgentGrantDenial();
    const before = logged.length;
    const res = await app.request(path);
    expect(res.status).toBe(403);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(0);
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context?.suppressed).toBe(DEAD_CREDENTIAL_BURST_SUPPRESSED);
  });

  test('a denial outside the agent-grant family keeps its per-request line', async () => {
    resetLogWindowsForTests();
    const app = appWithAgentGrantDenial();
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) await app.request('/v1/workspaces/w/audit');
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(3);
  });

  test('marking an agent-grant denial routes it and leaves a plain 403 unthrottled', () => {
    const plain = new HTTPException(403, { message: 'no access' });
    const marked = agentScopeDenialLike();
    markAgentGrantDenial(marked);
    expect(isAgentGrantDenial(marked)).toBe(true);
    expect(isAgentGrantDenial(plain)).toBe(false);
  });
});

describe('account-MFA step-up denials are throttled at the error handler (KRTX-4674)', () => {
  // The route throws what denyProjectAccess throws when an account's
  // "Require MFA" policy denies an aal1 browser session: buildDenialError's
  // typed 403. A caller that polls through it — the web app's workspace
  // panels refetch the sessions/triggers lists every few seconds — receives
  // the same refusal until its person completes the step-up, and per-request
  // logging turned that loop into a warn storm (KRTX-4674: 700+ lines in one
  // hour across three list routes, 0 in the 24 h before). The mark routes
  // the LINE through the shared window throttle; the typed 403 response,
  // which the web app's step-up dialog keys on, ships untouched every time.

  test('five identical denials log one info line; the typed 403 body ships every time', async () => {
    resetLogWindowsForTests();
    const app = appWithMfaDenial();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/projects/p/sessions');
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toMatchObject({
      error: 'This workspace requires multi-factor authentication. Verify your second factor and retry.',
      code: 'account_mfa_required',
    });
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first denial line');
    expect(first.message).toContain('-> 403 [HTTPException] This workspace requires multi-factor authentication');
    expect(first.context?.suppressed).toBe(0);
  });

  test('a window whose suppressed count left the churn band ships the next line at warn', async () => {
    resetLogWindowsForTests();
    const path = '/v1/projects/p/sessions';
    const reason = buildDenialError('project.session.read', 'account_mfa_required').message ?? '';
    const key = deadCredentialLogKey('GET', path, 403, reason);
    // A burst in a window that already expired: one decision opens it, the
    // rest are suppressed and left pending.
    const past = Date.now() - 601_000;
    expect(logWindowDecision(key, past).log).toBe(true);
    for (let i = 0; i < DEAD_CREDENTIAL_BURST_SUPPRESSED; i += 1) {
      expect(logWindowDecision(key, past + 1_000).log).toBe(false);
    }
    // The handler opens the next window and must ship the pending volume at
    // warn — a fleet of locked-out sessions grinding their polls is not the
    // designed churn (KRTX-4454's severity follows the volume).
    const app = appWithMfaDenial();
    const before = logged.length;
    const res = await app.request(path);
    expect(res.status).toBe(403);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(0);
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context?.suppressed).toBe(DEAD_CREDENTIAL_BURST_SUPPRESSED);
  });

  test('fifteen workspace paths share one refusal window', async () => {
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/projects/:workspaceId/sessions', (c) => {
      throw buildDenialError('project.session.read', 'account_mfa_required');
    });
    const before = logged.length;
    for (let i = 0; i < 15; i += 1) {
      const workspaceId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const res = await app.request(`/v1/projects/${workspaceId}/sessions`);
      expect(res.status).toBe(403);
    }
    expect(logged.slice(before).filter((entry) => entry.level === 'info')).toHaveLength(1);
    expect(logged.slice(before).filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });
});

describe('the escalation is capped at one warn per key per hour (KRTX-4674 residual)', () => {
  // The severity escalation is evaluated per ten-minute window and is
  // replica-local, so a caller grinding past the burst band through a whole
  // hour made EVERY window's line ship at warn: 16/15/15 lines per route
  // across three replicas in the 2026-11-11 09:00 UTC hour — above the
  // infra-sweep's new-warn-pattern bar (10/h per normalized pattern), which
  // re-filed this issue. The engine now caps the escalation: the hour's
  // first escalated line stays warn (the grind signal), the hour's other
  // windows drop to info carrying the suppressed count.

  test("the handler's second escalated window of the hour ships at info, suppressed carried", async () => {
    resetLogWindowsForTests();
    const path = '/v1/projects/p/sessions';
    const reason = buildDenialError('project.session.read', 'account_mfa_required').message ?? '';
    const key = deadCredentialLogKey('GET', path, 403, reason);
    // The hour's warn is already spent: one escalated line shipped this hour.
    expect(logWindowWarnDecision(key, Date.now())).toBe(true);
    // An expired window holds the burst band pending (the trick the tests
    // above use): the handler must open the next window and ship its pending
    // volume — at info now, the hourly warn budget spent.
    const past = Date.now() - 601_000;
    logWindowDecision(key, past);
    for (let i = 0; i < DEAD_CREDENTIAL_BURST_SUPPRESSED; i += 1) logWindowDecision(key, past + 1_000);
    const app = appWithMfaDenial();
    const before = logged.length;
    const res = await app.request(path);
    expect(res.status).toBe(403);
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.context?.suppressed).toBe(DEAD_CREDENTIAL_BURST_SUPPRESSED);
  });
});

describe('credential-fence refusals are throttled at the error handler (KRTX-4731)', () => {
  // The route throws what enforceTokenProjectScope throws for a
  // workspace-bound credential on a person route (here /v1/notifications; the
  // prod loop was POST /v1/mcp, rebound to the credential's own workspace on
  // 2026-11-11). The typed
  // 403 body already names the remedy (code credential_fence_refused, the
  // check, "use a personal key or sign in"), so a caller that cannot or will
  // not act on it — an OAuth workspace token looping the MCP endpoint —
  // receives the SAME refusal forever, and per-request logging turned that
  // loop into a warn storm (prod 2026-11-11: 31 warn lines in one hour on
  // POST /v1/mcp, 0 in the 24 h before). The mark routes the LINE through the
  // shared window throttle without touching the response, exactly as
  // markAgentGrantDenial does (KRTX-4635).
  function appWithFenceThrow(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/notifications', async (c) => {
      await enforceTokenProjectScope(c, '00000000-0000-4000-8000-000000000001', {
        principal: 'oauth-workspace-token',
      });
      return c.json({ ok: true });
    });
    return app;
  }

  test('five identical fence refusals log one info line; the typed 403 body ships every time', async () => {
    resetLogWindowsForTests();
    const app = appWithFenceThrow();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/notifications', { method: 'POST' });
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toMatchObject({
      error: true,
      status: 403,
      code: 'credential_fence_refused',
      check: 'person-route',
    });
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first refusal line');
    expect(first.message).toContain('-> 403 [HTTPException] This workspace key cannot call a person');
    expect(first.context?.suppressed).toBe(0);
  });

  test('a window whose suppressed count left the churn band ships the next line at warn', async () => {
    const app = appWithFenceThrow();
    // The reason the handler keys on: the thrown message, bounded at 200.
    const probe = await app.request('/v1/notifications', { method: 'POST' });
    expect(probe.status).toBe(403);
    const reason = ((await probe.json()) as { message: string }).message.slice(0, 200);
    const key = deadCredentialLogKey('POST', '/v1/notifications', 403, reason);
    // Drop the probe's window, then stage the burst.
    resetLogWindowsForTests();
    // A burst in a window that already expired: one decision opens it, the
    // rest are suppressed and left pending.
    const past = Date.now() - 601_000;
    expect(logWindowDecision(key, past).log).toBe(true);
    for (let i = 0; i < DEAD_CREDENTIAL_BURST_SUPPRESSED; i += 1) {
      expect(logWindowDecision(key, past + 1_000).log).toBe(false);
    }
    // The handler opens the next window and must ship the pending volume at
    // warn — a caller grinding on a refusal it never acts on is not the
    // designed churn (KRTX-4454's severity follows the volume).
    const before = logged.length;
    const res = await app.request('/v1/notifications', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(0);
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context?.suppressed).toBe(DEAD_CREDENTIAL_BURST_SUPPRESSED);
  });

  test('marking a fence refusal routes it and leaves a plain 403 unthrottled', () => {
    const plain = new HTTPException(403, { message: 'no access' });
    const marked = new HTTPException(403, { message: 'This workspace key cannot call platform routes' });
    markCredentialFenceDenial(marked);
    expect(isCredentialFenceDenial(marked)).toBe(true);
    expect(isCredentialFenceDenial(plain)).toBe(false);
  });
});

describe('preview sandbox denial warn is throttled at the error handler (KRTX-4768)', () => {
  // What combinedAuth throws when a valid caller is refused a sandbox proxy
  // route: the sandbox row is gone (the session stop deleted it) or the
  // caller lost access. The web client's workflow poll keeps hitting the
  // dead box's route every 5 s while its tab stays open, and per-request
  // logging turned that poll into a warn storm (89 lines in one hour
  // against a 1.58/h baseline, one tab on one dead box).
  function appWithPreviewSandboxDenial(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/p/:sandboxId/:port/kortix/runtime/workflows', () => {
      throw new HTTPException(403, { message: PREVIEW_SANDBOX_DENIED_MESSAGE });
    });
    return app;
  }

  test('the first refusal logs one info line; repeats inside the window are suppressed and the body is untouched', async () => {
    resetLogWindowsForTests();
    const app = appWithPreviewSandboxDenial();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/p/sbx_01M768H27CG7KMXCPE764BX4KC/8000/kortix/runtime/workflows');
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toEqual({
      error: true,
      message: PREVIEW_SANDBOX_DENIED_MESSAGE,
      status: 403,
    });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    expect(infos[0]?.message).toContain(`-> 403 [HTTPException] ${PREVIEW_SANDBOX_DENIED_MESSAGE}`);
    expect(infos[0]?.context?.suppressed).toBe(0);
  });

  test('distinct sandbox paths and the route-level suffixed variant share one window', async () => {
    // The bucket key must normalize the sandbox id out of the path, or every
    // polled box opens its own bucket and the throttle stops bounding the
    // warn lines across a fleet (the UUID treatment of KRTX-1564).
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/p/:sandboxId/:port/kortix/runtime/workflows', (c) => {
      throw new HTTPException(403, { message: PREVIEW_SANDBOX_DENIED_MESSAGE });
    });
    app.get('/v1/p/:sandboxId/:port/kortix/session/state', (c) => {
      // What assertPreviewSandboxAccess throws at the proxy route.
      throw new HTTPException(403, {
        message: `${PREVIEW_SANDBOX_DENIED_MESSAGE}, userId: ${crypto.randomUUID()}, sandboxId: ${c.req.param('sandboxId')}`,
      });
    });
    const before = logged.length;
    for (const id of ['sbx_01M768H27CG7KMXCPE764BX4KC', 'sbx_01M764P1WMZFH1ANREWF3ZGT90']) {
      const res = await app.request(`/v1/p/${id}/8000/kortix/runtime/workflows`);
      expect(res.status).toBe(403);
    }
    const res = await app.request('/v1/p/sbx_01M75P8WFTDNS1RP08M2RHV6Z4/8000/kortix/session/state');
    expect(res.status).toBe(403);
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    // Two sandbox paths on one route share one window; the suffixed variant
    // lives on its own route and gets its own window — one line per route.
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(2);
  });

  test('a 403 with a different reason still logs one warn per refusal', async () => {
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/p/:sandboxId/:port/kortix/runtime/workflows', () => {
      throw new HTTPException(403, { message: 'This sandbox is suspended' });
    });
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) {
      const res = await app.request('/v1/p/sbx_01M768H27CG7KMXCPE764BX4KC/8000/kortix/runtime/workflows');
      expect(res.status).toBe(403);
    }
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
  });
});

describe('person role denial warns are throttled at the error handler (KRTX-4801)', () => {
  // The route throws what assertAuthorized throws for a person whose role
  // lacks the action — the #12240 assert-form gates (`resolveAdmin` and
  // siblings). A host that renders the connect button polls
  // GET .../connect-requests for every session it shows, and a caller whose
  // role cannot ever act on the permission receives the same typed 403 on
  // every poll: prod 2026-11-12, 22 warn lines in one hour on that route,
  // 0 in the 24 h before. The mark routes the LINE through the shared window
  // throttle; the typed 403 body — the reason, the action, and (for the
  // role-shaped reasons) who grants it — ships untouched every time.
  function appWithRoleDenial(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/connectors/workspaces/:workspaceId/sessions/:sessionId/connect-requests', () => {
      throw buildDenialError('project.connector.write', 'role');
    });
    return app;
  }

  test('five identical role denials log one info line; the typed 403 body names the permission every time', async () => {
    resetLogWindowsForTests();
    const app = appWithRoleDenial();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/connectors/workspaces/w/sessions/s/connect-requests');
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toMatchObject({
      code: 'role',
      action: 'project.connector.write',
      workspace_action: 'workspace.connector.write',
    });
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first denial line');
    expect(first.message).toContain(
      '-> 403 [HTTPException] You don\'t have permission to perform this action (workspace.connector.write).',
    );
    expect(first.context?.suppressed).toBe(0);
  });

  test('role-shaped reasons the wording branch names keep their remedy in the body and join the same throttle', async () => {
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/connectors/workspaces/:workspaceId/sessions/:sessionId/connect-requests', () => {
      throw buildDenialError('project.connector.write', 'project_role_insufficient');
    });
    const before = logged.length;
    const res = await app.request('/v1/connectors/workspaces/w/sessions/s/connect-requests');
    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text()).message).toContain('A workspace owner or admin grants');
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(1);
  });

  test('a denial whose constraint clears in-session stays per-request (sso_required)', async () => {
    // The doctrine boundary (denial-message.ts): a remedy a caller can act on
    // in-session — one redirect — keeps its per-request warn line.
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.get('/v1/plain', () => {
      throw buildDenialError('project.connector.write', 'sso_required');
    });
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) await app.request('/v1/plain');
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
  });
});

describe('agent-access denials are throttled at the error handler (KRTX-4800)', () => {
  // What projects/lib/agent-access.ts `denial()` throws for a caller whose
  // session's agent is not theirs: the typed 403 (`no_agent_access` or
  // `agent_not_accessible`), marked. The gate-level pin that the constructor
  // itself marks lives in __tests__/unit-agent-access-denial-mark.test.ts;
  // this file pins what the mark does at the error handler.
  function agentAccessDenialLike(
    message = "You don't have access to any agent in this project. Ask a manager to grant you one.",
  ): HTTPException {
    const err = new HTTPException(403, {
      message,
      res: new Response(
        JSON.stringify({ error: message, message, code: 'no_agent_access', action: 'project.session.start', accessible_agents: [] }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    });
    markAgentAccessDenial(err);
    return err;
  }

  function appWithAgentAccessDenial(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/workspaces/:workspaceId/sessions/:sessionId/start', () => {
      throw agentAccessDenialLike();
    });
    app.post('/v1/unmarked-start', () => {
      throw new HTTPException(403, { message: 'no access' });
    });
    return app;
  }

  test('an unmarked 403 still logs one warn line per refusal', () => {
    const app = appWithAgentAccessDenial();
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) app.request('/v1/unmarked-start', { method: 'POST' });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
    for (const warn of warns) {
      expect(warn.message).toContain('-> 403 [HTTPException] no access');
      expect(warn.context?.suppressed).toBeUndefined();
    }
  });

  test('five identical agent-access refusals log one info line and ship the typed body verbatim', async () => {
    resetLogWindowsForTests();
    const app = appWithAgentAccessDenial();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/workspaces/w/sessions/s/start', { method: 'POST' });
      expect(res.status).toBe(403);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toEqual({
      error: "You don't have access to any agent in this project. Ask a manager to grant you one.",
      message: "You don't have access to any agent in this project. Ask a manager to grant you one.",
      code: 'no_agent_access',
      action: 'project.session.start',
      accessible_agents: [],
    });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(0);
    const infos = logged.slice(before).filter((l) => l.level === 'info');
    expect(infos).toHaveLength(1);
    const first = infos[0];
    if (!first) throw new Error('expected the first refusal line');
    expect(first.message).toContain(
      '-> 403 [HTTPException] You don\'t have access to any agent in this project. Ask a manager to grant you one.',
    );
    expect(first.context?.suppressed).toBe(0);
    expect(first.context?.reason).toContain('agent in this project');
  });

  test('the named-agent form (agent_not_accessible) joins the same throttle family', async () => {
    resetLogWindowsForTests();
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/workspaces/:workspaceId/sessions/:sessionId/start', () => {
      const err = agentAccessDenialLike(
        "You don't have access to the legal agent — pick one of: sales.",
      );
      // The named-agent refusal carries code agent_not_accessible; the mark is
      // what throttles it, so the bucket here follows the mark, not the code.
      expect(isAgentAccessDenial(err)).toBe(true);
      throw err;
    });
    const before = logged.length;
    for (let i = 0; i < 4; i += 1) {
      const res = await app.request('/v1/workspaces/w/sessions/s/start', { method: 'POST' });
      expect(res.status).toBe(403);
    }
    expect(logged.slice(before).filter((l) => l.level === 'warn')).toHaveLength(0);
    expect(logged.slice(before).filter((l) => l.level === 'info')).toHaveLength(1);
  });
});
