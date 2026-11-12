/**
 * The `[preview] session access refused` line is rate-limited; the 403 is not.
 *
 * A session-bound client polling a designed-refused surface (the sibling-reach
 * rule below) emitted one warn per request — 416 lines in 14 h from ONE client
 * against one box, 5.88x the pattern's baseline (KRTX-4683). The refusal
 * response is unchanged; only the LINE is throttled, the KRTX-1039 /
 * KRTX-4442 treatment (shared/dead-credential-log.ts): first per window, the
 * next line of a later window carrying `suppressed`, severity following the
 * window's volume (KRTX-4454) so a stuck client cannot keep a 0-baseline warn
 * pattern alive for the infra sweep.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';
import { DEAD_CREDENTIAL_BURST_SUPPRESSED } from '../../shared/dead-credential-log';
import { logger } from '../../lib/logger';
import { resetLogWindowsForTests } from '../../shared/log-window';

const realOwnership = await import('../../shared/preview-ownership');
mock.module('../../shared/preview-ownership', () => ({
  ...realOwnership,
  canAccessSandboxSession: async () => false,
  takeSessionAccessRefusal: () => ({
    spaceHidden: false,
    sessionId: 'sess-target',
    projectId: 'proj-1',
    visibility: 'private',
    origin: 'schedule',
    sessionOwnedByCaller: false,
    isTriggerSession: true,
    canManageProject: true,
    managerReason: 'super_admin',
    sessionGrants: 0,
    callerSessionId: 'sess-caller',
    boundCredentialSessionId: 'sess-caller',
  }),
}));

mock.module('../../iam', () => ({
  PROJECT_ACTIONS: {},
  authorize: async () => ({ allowed: false, reason: 'test' }),
}));
mock.module('../../iam/actor', () => ({
  actorForUser: (userId: string, accountId: string) => ({ type: 'user', id: userId, accountId }),
}));
mock.module('../pre-prompt-env-sync', () => ({
  DEFAULT_AGENT_SENTINEL: 'default',
  jsonProxyError: (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status }),
}));

const { refuseSessionOrControlAccess, reportSessionAccessRefusal } = await import('./access');

const MESSAGE = '[preview] session access refused';

function refusalInput() {
  return {
    access: {
      kind: 'principal' as const,
      userId: 'user-1',
      callerSessionId: 'sess-caller',
      boundCredentialSessionId: 'sess-caller',
      sandboxAuthored: true,
    },
    record: {
      sandboxId: 'sbx-internal-1',
      externalId: 'sbx-1',
      sessionId: 'sess-target',
      agentName: null,
      projectId: 'proj-1',
      accountId: 'acct-1',
      provider: 'daytona',
      status: 'active',
      baseUrl: '',
      serviceKey: null,
    },
    sandboxId: 'sbx-1',
    userId: 'user-1',
    callerSessionId: 'sess-caller',
    boundCredentialSessionId: 'sess-caller',
    upstreamPort: 8000,
    remainingPath: '/file/content',
    queryString: '',
    origin: 'https://web.test',
    method: 'GET',
  };
}

/** Every shipped refusal line, whichever channel the emit site uses. */
type ShippedLine = { channel: string; args: unknown[] };
let shipped: ShippedLine[] = [];

function shippedRefusalLines(): ShippedLine[] {
  return shipped.filter((line) => typeof line.args[0] === 'string' && (line.args[0] as string).startsWith(MESSAGE));
}

let spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  resetLogWindowsForTests();
  shipped = [];
  spies = [
    spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      shipped.push({ channel: 'logger.info', args });
    }),
    spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => {
      shipped.push({ channel: 'logger.warn', args });
    }),
    spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      shipped.push({ channel: 'console.warn', args });
    }),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe('[preview] session access refused — the line is throttled, the 403 is not', () => {
  test('thirty refusals ship ONE line, and every response is still 403', async () => {
    let thrown = 0;
    for (let i = 0; i < 30; i += 1) {
      try {
        await refuseSessionOrControlAccess(refusalInput());
        throw new Error('expected the session gate to refuse');
      } catch (err) {
        if (err instanceof HTTPException && err.status === 403) thrown += 1;
        else throw err;
      }
    }
    expect(thrown).toBe(30);
    const lines = shippedRefusalLines();
    expect(lines.length).toBe(1);
    // The line ships at info in the churn band, through the real logger —
    // a console.info would never reach Better Stack (the patch only covers
    // console.error/warn).
    expect(lines[0]?.channel).toBe('logger.info');
    // KRTX-4412's diagnosability survives the throttle: the verdict inputs
    // ship with the line.
    const fields = lines[0]?.args[1] as Record<string, unknown>;
    expect(fields.isTriggerSession).toBe(true);
    expect(fields.visibility).toBe('private');
    expect(fields.boundCredentialSessionId).toBe('sess-caller');
  });

  test('the first line of the next window carries the suppressed count', () => {
    const start = Date.now();
    for (let i = 0; i < 30; i += 1) reportSessionAccessRefusal({ n: i }, start);
    expect(shippedRefusalLines().length).toBe(1);
    // Eleven minutes later the window has passed: the next refusal ships and
    // reports what the last window swallowed.
    reportSessionAccessRefusal({ n: 30 }, start + 11 * 60_000);
    const lines = shippedRefusalLines();
    expect(lines.length).toBe(2);
    expect((lines[1]?.args[1] as Record<string, unknown>).suppressed).toBe(29);
  });

  test('severity follows the window volume: churn ships info, a hammering client ships warn', () => {
    const start = Date.now();
    // Under the band: designed churn, the line ships at info.
    for (let i = 0; i < 3; i += 1) reportSessionAccessRefusal({ n: i }, start);
    reportSessionAccessRefusal({ n: 3 }, start + 11 * 60_000);
    expect((shippedRefusalLines()[1]?.args[1] as Record<string, unknown>).suppressed).toBe(2);
    expect(shipped.some((line) => line.channel === 'logger.warn')).toBe(false);
    expect(shipped.filter((line) => line.channel === 'logger.info').length).toBe(2);

    // Above the band (KRTX-4454's DEAD_CREDENTIAL_BURST_SUPPRESSED): a caller
    // hammering the gate keeps the line at warn.
    for (let i = 0; i < 12; i += 1) reportSessionAccessRefusal({ n: i }, start + 30 * 60_000);
    reportSessionAccessRefusal({ n: 12 }, start + 41 * 60_000);
    const warns = shipped.filter((line) => line.channel === 'logger.warn');
    expect(warns.length).toBe(1);
    expect((warns[0]?.args[1] as Record<string, unknown>).suppressed).toBe(11);
  });

  test('a refusal with no recorded verdict still names its cache branch', async () => {
    const realOwnershipModule = realOwnership;
    mock.module('../../shared/preview-ownership', () => ({
      ...realOwnershipModule,
      canAccessSandboxSession: async () => false,
      takeSessionAccessRefusal: () => null,
    }));
    try {
      await refuseSessionOrControlAccess(refusalInput());
      expect.unreachable();
    } catch (err) {
      expect((err as HTTPException).status).toBe(403);
    }
    const fields = shippedRefusalLines()[0]?.args[1] as Record<string, unknown>;
    expect(fields.detail).toBe('no recorded verdict (served from the visibility cache)');
  });
});

describe('the escalation shares the hourly warn cap (KRTX-4674)', () => {
  // The severity escalation is evaluated per ten-minute window and is
  // replica-local: a caller grinding past the burst band through a whole hour
  // made every window's line ship at warn (16/15/15 per route across three
  // replicas in one hour — above the infra-sweep's 10/h new-warn-pattern
  // bar). The escalation asks the shared hourly warn budget
  // (logWindowWarnDecision) before it ships warn: the hour's first escalated
  // line stays warn, the second drops to info carrying the suppressed count,
  // and the slot renews after the hour.
  test('first escalated window warns, the second ships info with the suppressed count, the slot renews after the hour', () => {
    const band = DEAD_CREDENTIAL_BURST_SUPPRESSED;
    const start = Date.now();
    // Window 1 opens and fills past the burst band (the first call ships the
    // line, the rest swell the pending count).
    for (let i = 0; i <= band; i += 1) reportSessionAccessRefusal({ n: i }, start + i * 1_000);
    // The hour's first escalated line ships at warn.
    reportSessionAccessRefusal({ n: band }, start + 11 * 60_000);
    // Window 2 fills past the band again, inside the same warn hour.
    for (let i = 0; i < band; i += 1) {
      reportSessionAccessRefusal({ n: i }, start + 11 * 60_000 + 1_000 + i * 1_000);
    }
    // The second escalated window of the hour drops to info, suppressed kept.
    reportSessionAccessRefusal({ n: band }, start + 22 * 60_000);
    // Window 3 fills past the band; past the warn hour the slot renews.
    for (let i = 0; i < band; i += 1) {
      reportSessionAccessRefusal({ n: i }, start + 22 * 60_000 + 1_000 + i * 1_000);
    }
    reportSessionAccessRefusal({ n: band }, start + 73 * 60_000);

    const lines = shippedRefusalLines();
    expect(lines.map((line) => line.channel)).toEqual(['logger.info', 'logger.warn', 'logger.info', 'logger.warn']);
    expect((lines[1]?.args[1] as Record<string, unknown>).suppressed).toBe(band);
    expect((lines[2]?.args[1] as Record<string, unknown>).suppressed).toBe(band);
  });
});
