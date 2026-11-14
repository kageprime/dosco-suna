/**
 * GET /v1/projects/:projectId/sessions/:sessionId/events
 *
 * ONE client connection for everything that MOVES in a session.
 *
 * Before this route a live session cost the browser a permanent SSE connection
 * THROUGH the sandbox proxy to OpenCode's `/global/event`, plus a 2 s
 * `/permission` poll, plus a 2 s `/question` poll, plus a 30 s transcript
 * tail-verify, plus a 30 s `/kortix/health` probe, plus `/turn` and `/prompts`
 * on their own timers. Seven clocks, six of them polling, and none of them able
 * to tell "nothing happened" from "I lost the connection".
 *
 * This route multiplexes all of it onto one stream with two cursors.
 *
 * ─── TWO CHANNELS, TWO ID-SPACES, NEVER RENUMBERED ─────────────────────────
 * WS-Z1's rule is load-bearing and is obeyed literally:
 *
 *   channel: 'runtime'  — the daemon's own envelopes, FORWARDED VERBATIM. The
 *     daemon assigned `seq`; this route adds `channel` and `epoch` and changes
 *     nothing else. It does not reorder, does not renumber, does not drop, and
 *     does not decide what a client missed — `?since=`/`?epoch=` are passed
 *     straight through to the daemon, which owns replay and `kortix.resync`.
 *
 *   channel: 'control'  — the API's own snapshots, carrying `cseq` + `cepoch`
 *     in a SEPARATE id-space. A client that mixed the two cursors would resume
 *     at a number that means nothing on the other side, which is exactly the
 *     failure the separation exists to make impossible.
 *
 * The SSE `id:` field carries BOTH cursors as `epoch|seq|cepoch|cseq`, so a
 * `Last-Event-ID` reconnect (the only thing `EventSource` sends on its own)
 * restores the same position an explicit `?since=&epoch=&since_control=&cepoch=`
 * would. Blank segments mean "no position on that channel yet".
 *
 * ─── THE STREAM NEVER ERRORS BECAUSE THE BOX IS ABSENT ─────────────────────
 * A stopped, booting, unreachable or never-provisioned sandbox produces
 * `kortix.runtime.status {state:'down'}` and NOTHING ELSE changes: the control
 * channel keeps delivering the queue, the turn verdict and the wake progress,
 * which is precisely the state a user watching a waking box needs to see. The
 * response is 200 from the first byte in every one of those cases.
 *
 * ─── `?channels=control` ───────────────────────────────────────────────────
 * Serves the control channel and the stream's own hello/heartbeat, and nothing
 * else: no sandbox read, no daemon attach. Its reconciler reads the queue only,
 * at the slow cadence (`ControlReconcilerMode`). The SDK's prompt queue reads
 * it (`openSessionControlStream`). The default serves both channels.
 *
 * ─── `?schema=v2`: THE SESSION LOG (P4.4) ──────────────────────────────────
 * The runtime channel carries `log.*` frames (`SESSION_LOG_EVENTS`) IN PLACE OF
 * the v1 transcript frames (`V1_TRANSCRIPT_EVENTS`); every other frame stays.
 * The box is attached with `?schema=v2` and its stream relayed (its own seq and
 * epoch); every daemon since 2026-10-11 serves it (`session.log.v2`). Absent,
 * empty or `v1`: the stream is the v1 stream, byte for byte. Another value: 400.
 *
 * ─── BOUNDED, AND QUIET ON A STOPPED BOX ───────────────────────────────────
 * A slow client gets backpressure: past {@link STREAM_BUFFER_BYTES} unread, the
 * pump stops reading the daemon, whose ring holds the rest. A client that stops
 * reading entirely is cut at {@link STREAM_MAX_BACKLOG_BYTES} and resumes at its
 * cursor. A hang-up cancels the daemon body at once. A stream on a stopped box
 * reads the box row once and then waits for its `kortix_session_changed`
 * NOTIFY, not on a 5 s poll.
 *
 * ─── THIS ROUTE NEVER WAKES A BOX ──────────────────────────────────────────
 * It attaches only when the sandbox row ALREADY says `active`. Waking is
 * `POST .../start`'s job and only its job; a read that could start a sandbox
 * would resurrect reaper-stopped boxes and bill for them, which is a real
 * incident in this repo's register, not a hypothetical.
 */

import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { PROJECT_ACTIONS } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { resolveAndAuthorizeAgent } from '../lib/agent-access';
import { reauthorizeWakeLadderActor } from '../lib/wake-ladder-authorization';
import { actorOf } from '../../iam/actor';
import { auth, errors } from '../../openapi';
import {
  assertProjectCapability,
  loadProjectForUser,
  loadVisibleSession,
  projectCapabilityAllowed,
  sessionIsTombstoned,
} from '../lib/access';
import { projectsApp } from '../lib/app';
import { callerKortixSessionId } from '../../middleware/caller-session';
import { isUuid } from '../../shared/validate';
import { isProjectSessionPrincipal } from '../../iam/agent-scope';
import type { WakeLadderActor } from '../lib/session-control-reconciler';
import {
  SESSION_EVENT_STREAM_HEADERS,
  decodeStreamId,
  openSessionEventStream,
  type DecodedStreamId,
} from '../lib/session-event-stream';
import { workspaceIdParam } from '../../shared/route-params';

function parseCursorQuery(c: {
  req: { query: (name: string) => string | undefined; header: (name: string) => string | undefined };
}): DecodedStreamId {
  const fromHeader = decodeStreamId(c.req.header('last-event-id'));
  const since = c.req.query('since');
  const cseq = c.req.query('since_control');
  return {
    // An explicit query parameter always beats the header: the SDK sends what
    // it actually applied, and the browser sends whatever it last received.
    epoch: c.req.query('epoch')?.trim() || fromHeader.epoch,
    seq: since && /^\d+$/.test(since) ? Number(since) : fromHeader.seq,
    cepoch: c.req.query('cepoch')?.trim() || fromHeader.cepoch,
    cseq: cseq && /^\d+$/.test(cseq) ? Number(cseq) : fromHeader.cseq,
  };
}

export function registerSessionStreamRoutes(): void {
  projectsApp.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/sessions/{sessionId}/events',
      tags: ['sessions'],
      summary: 'Stream live events of a session',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), sessionId: z.string() }),
        query: z.object({
          since: z.string().optional(),
          epoch: z.string().optional(),
          since_control: z.string().optional(),
          cepoch: z.string().optional(),
          /** `control`: the control channel only, no daemon attach. Default: both. */
          channels: z.enum(['all', 'control']).optional(),
          /** A browser tab's presence id: the stream renews its lease (R5.3). */
          tab_id: z.string().optional(),
          /** `v2`: `log.*` frames in place of the v1 transcript frames. Absent, empty or `v1`: the v1 stream. */
          schema: z.enum(['', 'v1', 'v2']).optional(),
        }),
      },
      responses: {
        200: {
          description:
            'A never-ending text/event-stream multiplexing the sandbox runtime channel ' +
            '(daemon seq/epoch, forwarded verbatim) and the control channel (cseq/cepoch).',
          content: { 'text/event-stream': { schema: z.any() } },
        },
        ...errors(400, 404),
      },
    }),
    async (c: any) => {
      const projectId = workspaceIdParam(c);
      const sessionId = c.req.param('sessionId');
      if (!isUuid(sessionId)) return c.json({ error: 'Invalid session id' }, 400);

      // The SAME gate `open-bundle` applies, for the same reason: this stream
      // carries strictly the facts that route already serves, so it must not be
      // reachable by anyone who could not have asked for them one at a time.
      const loaded = await loadProjectForUser(c, projectId, 'read');
      if (!loaded) return c.json({ error: 'Not found' }, 404);
      await assertProjectCapability(
        c,
        loaded.userId,
        loaded.row.accountId,
        projectId,
        PROJECT_ACTIONS.PROJECT_SESSION_READ,
      );
      const visible = await loadVisibleSession(
        loaded,
        sessionId,
        callerKortixSessionId(c),
        callerKortixSessionId(c),
      );
      if (!visible) return c.json({ error: 'Not found' }, 404);
      if (sessionIsTombstoned(visible.row)) return c.json({ error: 'Not found' }, 404);

      const cursor = parseCursorQuery(c);
      const controlOnly = c.req.query('channels') === 'control';
      // The server wake ladder acts as a watcher who could press Restart
      // themselves: the same gates `/start` and `/restart` apply. Anyone else
      // sees the ladder's state and never triggers it.
      const ladderActor = controlOnly ? null : await wakeLadderActorFor(c, projectId, sessionId, visible);
      // Presence is a human browser tab's: the same gates `PUT .../presence`
      // applies, including who may keep the computer awake (KRTX-1729).
      const presenceTabId = c.req.query('tab_id');
      const presenceRenewal =
        presenceTabId &&
        isUuid(presenceTabId) &&
        loaded.actor?.credential.kind === 'jwt' &&
        !callerKortixSessionId(c)
          ? {
              userId: String(loaded.userId),
              tabId: presenceTabId,
              extendDeadline: await projectCapabilityAllowed(
                c,
                String(loaded.userId),
                String(loaded.row.accountId),
                projectId,
                PROJECT_ACTIONS.PROJECT_SESSION_START,
              ),
            }
          : null;
      const userId = String(c.get('userId') ?? loaded.userId ?? '');

      // Whether THIS viewer may stop the running turn. The turn frame is one
      // broadcast per session; the answer is per person, so it is decided here
      // and the prompter's id never reaches the client.
      const stopViewer = {
        canManageLifecycle: visible.canManageLifecycle,
        callerUserId: isProjectSessionPrincipal(c) ? null : String(loaded.userId),
      };

      return new Response(
        openSessionEventStream({
          sessionId,
          projectId,
          userId,
          loaded,
          callerSessionId: callerKortixSessionId(c),
          cursor,
          controlOnly,
          sessionLog: c.req.query('schema') === 'v2',
          ladderActor,
          stopViewer,
          presenceRenewal,
        }),
        { status: 200, headers: SESSION_EVENT_STREAM_HEADERS },
      ) as any;
    },
  );
}

async function wakeLadderActorFor(
  c: Context,
  projectId: string,
  sessionId: string,
  visible: { row: { agentName: string | null; spaceId: string | null }; canManageLifecycle?: boolean },
): Promise<WakeLadderActor | null> {
  // A cheap pre-filter at open. The real decision is `authorize()`, asked
  // again right before every step (Strix CWE-863).
  if (!visible.canManageLifecycle) return null;
  if (c.get('authType') === 'apiKey' && c.get('apiKeyType') === 'user') return null;
  try {
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_SESSION_START);
    const loaded = await loadProjectForUser(c, projectId, 'session');
    if (!loaded) return null;
    await resolveAndAuthorizeAgent(c, loaded, projectId, null, visible.row.agentName, undefined, visible.row.spaceId);
    const actor = await actorOf(c, loaded.row.accountId);
    // An agent's own stream never drives restarts of its session.
    if (actor.credential.kind === 'agent_session') return null;
    const authorization = {
      actor,
      onBehalfOf: c.get('onBehalfOfUserId') as string | null | undefined,
      isServiceAccount: c.get('authType') === 'service_account',
      userId: loaded.userId,
      projectId,
      sessionId,
    };
    return { authorize: () => reauthorizeWakeLadderActor(authorization) };
  } catch {
    return null;
  }
}

