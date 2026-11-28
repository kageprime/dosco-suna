/**
 * My Kortix reads sessions with its person's standing.
 *
 * My Kortix acts with exactly its person's rights: its grant is not governed
 * (`isGovernedAgentGrant`), so `authorize` evaluates its token as that person.
 * The token is still bound to its own session, and the session read rules
 * (`session-visibility.ts`, `session-list.ts`) drop every bound token's
 * manager and oversight standing, so a sandbox started by an admin cannot read
 * the project's other private sessions. That rule is right for an agent and
 * wrong for My Kortix: it listed a trigger run its person can open, then got
 * "not found" when it read it.
 *
 * The standing comes back on read routes only, and only for sessions no
 * person owns (a trigger run, a session an agent started), outside another
 * member's DM. A private session another member started stays closed to My
 * Kortix even when its person may open it through account oversight.
 *
 * Its own module, not `iam/actor.ts`: 19 suites replace that module wholesale
 * with `mock.module`, and every name added there is a name each stub would have
 * to declare.
 */
import { accountTokens, projectSpaces, readStoredAgentGrant } from '@kortix/db';
import { isMyKortixAgentName } from '@kortix/shared';
import { and, eq } from 'drizzle-orm';
import type { Actor } from '../../iam/actor';
import { db } from '../../shared/db';

/**
 * The person a My Kortix session token acts for, or null.
 *
 * A My Kortix token names no service account (`mintSessionToken`), so the auth
 * layer classifies it as a `pat`. A session first started with another agent
 * and then prompted with My Kortix keeps that agent's service account and is an
 * `agent_session`. Both carry the facts on their token row: the session, the
 * grant, and `on_behalf_of`. The row is read fresh: every turn rewrites
 * `on_behalf_of` (`projects/lib/on-behalf-of.ts`).
 *
 * Null for every other credential; for an agent that authorizes as its
 * service account (governed, activated, or an agent key); for a token of
 * another session than `boundSessionId`; for a grant that is not My Kortix
 * with `permissions: 'all'` (`disabledMyKortixAgentGrant`: My Kortix turned off
 * in kortix.yaml); and when `on_behalf_of` is not the token's user: an
 * unattended turn, or another member prompted the session.
 */
export async function myKortixPersonId(
  actor: Actor | null | undefined,
  boundSessionId: string | null,
): Promise<string | null> {
  if (!actor || !boundSessionId) return null;
  const c = actor.credential;
  if (c.kind === 'agent_session') {
    if (c.agentPrincipal || c.activated || c.serviceAccountKey) return null;
  } else if (c.kind !== 'pat') {
    return null;
  }
  const [row] = await db
    .select({
      sessionId: accountTokens.sessionId,
      agentGrant: accountTokens.agentGrant,
      onBehalfOfUserId: accountTokens.onBehalfOfUserId,
    })
    .from(accountTokens)
    .where(eq(accountTokens.tokenId, c.tokenId))
    .limit(1);
  if (!row || row.sessionId !== boundSessionId) return null;
  const grant = readStoredAgentGrant(row.agentGrant);
  if (!grant || !isMyKortixAgentName(grant.agent) || grant.permissions !== 'all') return null;
  return row.onBehalfOfUserId && row.onBehalfOfUserId === actor.userId ? actor.userId : null;
}

/**
 * The project's DM spaces that belong to someone other than `personId`. A run
 * filed in another member's DM is that member's private conversation, even
 * when an agent's service account owns the row.
 */
export async function foreignDmSpaceIds(projectId: string, personId: string): Promise<Set<string>> {
  const rows = await db
    .select({ spaceId: projectSpaces.spaceId, dmUserId: projectSpaces.dmUserId })
    .from(projectSpaces)
    .where(and(eq(projectSpaces.projectId, projectId), eq(projectSpaces.kind, 'dm')));
  return new Set(rows.filter((row) => row.dmUserId !== personId).map((row) => row.spaceId));
}
