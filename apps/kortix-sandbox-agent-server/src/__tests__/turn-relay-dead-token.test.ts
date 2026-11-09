import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  SESSION_TOKEN_DEAD_TRIP_THRESHOLD,
  noteControlPlaneResponse,
  resetSessionTokenHealthForTests,
} from '@/lib/kortix-api/session-token-health';
import {
  relayMemoryGuardTurnEnd,
  relayTurnBegin,
  relayTurnEnd,
} from '@/harness/shared/turn-relay';
import { resetWorkspaceRouteMemory } from '@/lib/kortix-api/workspace-routes';

// KRTX-4456: a parked lease (the sandbox row left provisioning/active) makes
// every relay of a still-running box draw the terminal
// `401 Session token is not active`. The breaker
// (session-token-health.ts) caps a caller only when the relay ladders stop on
// that definitive answer: `claimInitialTurn` and `relaySteerRead` already
// treat any non-5xx as final, but `relayTurnBegin` retried its second
// attempt, `relayTurnEnd` retried all four attempts (its own doc: "a
// non-ok status is definitive"), and `relayMemoryGuardTurnEnd` bypassed the
// breaker entirely. One refused turn-end relay cost 4 POSTs, ~6 s of ladder
// sleeps, and kept a churn wave's warn family hot.

const KEYS = ['KORTIX_PROJECT_ID', 'KORTIX_SESSION_ID', 'KORTIX_TOKEN', 'KORTIX_API_URL'] as const;
let saved: Record<string, string | undefined> = {};
const servers: Array<{ stop(closeActive?: boolean): void }> = [];

const deadToken401 = (): Response =>
  Response.json(
    { error: true, message: 'Session token is not active', status: 401, code: 'session_token_revoked' },
    { status: 401 },
  );

/** A fake control plane that records the relay `kind` of every turn-stream POST. */
function fakeTurnStream(respond: (n: number, kind: string) => Response): { posts: string[] } {
  const posts: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/turn-stream')) {
        const body = (await request.json()) as { kind?: string };
        posts.push(body.kind ?? '?');
        return respond(posts.length, body.kind ?? '?');
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  process.env.KORTIX_API_URL = `http://127.0.0.1:${server.port}`;
  return { posts };
}

let sleep: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  resetSessionTokenHealthForTests();
  resetWorkspaceRouteMemory();
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.KORTIX_PROJECT_ID = 'project-1';
  process.env.KORTIX_SESSION_ID = 'session-1';
  process.env.KORTIX_TOKEN = 'session-token';
  // A ladder's backoff must not wait on the real clock; a stubbed sleep also
  // lets a retry ladder finish inside its test, so no stale attempt leaks
  // into the next test's fake server.
  sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined as never);
});

afterEach(() => {
  sleep?.mockRestore();
  sleep = null;
  resetSessionTokenHealthForTests();
  resetWorkspaceRouteMemory();
  for (const s of servers.splice(0)) s.stop(true);
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('turn relay vs a terminal-credential 401', () => {
  test('relayTurnEnd stops after one POST and returns false', async () => {
    const { posts } = fakeTurnStream(() => deadToken401());

    const settled = await relayTurnEnd({ runtimeSessionId: 'ses_root', messageId: 'msg_user', status: 'idle' });

    expect(settled).toBe(false);
    expect(posts).toEqual(['end']);
  });

  test('relayTurnEnd still retries a 5xx', async () => {
    const { posts } = fakeTurnStream((n) => (n < 3 ? new Response('boom', { status: 503 }) : Response.json({ ok: true })));

    const settled = await relayTurnEnd({ runtimeSessionId: 'ses_root', messageId: 'msg_user', status: 'idle' });

    expect(settled).toBe(true);
    expect(posts).toEqual(['end', 'end', 'end']);
  });

  test('relayTurnBegin stops after one POST on a dead-token 401', async () => {
    const { posts } = fakeTurnStream(() => deadToken401());

    await relayTurnBegin('ses_root', 'msg_user');

    expect(posts).toEqual(['turn_begin']);
  });

  test('relayMemoryGuardTurnEnd skips while the breaker is tripped', async () => {
    const { posts } = fakeTurnStream(() => deadToken401());
    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) noteControlPlaneResponse(401, 'Session token is not active');

    const relayed = await relayMemoryGuardTurnEnd({
      reason: 'rss over guard',
      aborted: true,
      runtimeRssMb: 4096,
      runtimeSessionId: 'ses_root',
      turnMessageId: 'msg_user',
    });

    expect(relayed).toBe(false);
    expect(posts).toEqual([]);
  });

  test('a refused memory-guard relay feeds the breaker', async () => {
    fakeTurnStream(() => deadToken401());

    for (let i = 0; i < SESSION_TOKEN_DEAD_TRIP_THRESHOLD; i++) {
      await relayMemoryGuardTurnEnd({
        reason: 'rss over guard',
        aborted: true,
        runtimeRssMb: 4096,
        runtimeSessionId: 'ses_root',
        turnMessageId: 'msg_user',
      });
    }

    // The refusals reached the shared streak: the breaker is now tripped, so
    // the next relay skips the call instead of adding a refused POST.
    const { posts } = fakeTurnStream(() => deadToken401());
    const relayed = await relayMemoryGuardTurnEnd({
      reason: 'rss over guard',
      aborted: true,
      runtimeRssMb: 4096,
      runtimeSessionId: 'ses_root',
      turnMessageId: 'msg_user',
    });
    expect(relayed).toBe(false);
    expect(posts).toEqual([]);
  });
});
