import { projectSpaces, serviceAccounts } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { Actor } from '../iam/actor';
import { accountMemberRow } from '../iam/membership-read';
import { db } from '../shared/db';
import { isHumanCaller } from '../connectors/share';
import { triggerReaderStanding, type TriggerReaderPrincipal } from './trigger-reader-policy';

/** Resolve the actual credential, never a launching human's standing. Fresh membership revokes on removal. */
export async function triggerReaderPrincipal(
  actor: Actor | null | undefined,
  projectId: string,
  bound: string | null,
): Promise<TriggerReaderPrincipal> {
  if (!actor) return { kind: 'none' };
  if (isHumanCaller({ credentialKind: actor.credential.kind, boundSessionId: bound })) {
    return { kind: 'human', member: (await accountMemberRow(actor.accountId, actor.userId)).length > 0 };
  }
  const credential = actor.credential;
  if (credential.kind !== 'agent_session' && credential.kind !== 'service_account') return { kind: 'none' };
  const [identity] = await db.select({ name: serviceAccounts.agentName }).from(serviceAccounts).where(and(
    eq(serviceAccounts.serviceAccountId, credential.serviceAccountId),
    eq(serviceAccounts.accountId, actor.accountId),
    eq(serviceAccounts.projectId, projectId),
    eq(serviceAccounts.status, 'active'),
  )).limit(1);
  return identity?.name ? { kind: 'agent', name: identity.name } : { kind: 'none' };
}

/** One space-kind read for a list, including DMs that reader standing must never open. */
export async function triggerReaderSpaceKinds(projectId: string, spaceIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(spaceIds)];
  if (ids.length === 0) return new Map();
  const spaces = await db.select({ spaceId: projectSpaces.spaceId, kind: projectSpaces.kind }).from(projectSpaces).where(and(
    eq(projectSpaces.projectId, projectId), inArray(projectSpaces.spaceId, ids),
  ));
  return new Map(spaces.map((space) => [space.spaceId, space.kind]));
}

export async function mayReadTriggerSession(
  row: { metadata: Record<string, unknown> | null; spaceId: string | null; projectId: string },
  principal: TriggerReaderPrincipal,
  spaceKinds?: ReadonlyMap<string, string>,
): Promise<boolean> {
  const session = { metadata: row.metadata, spaceKind: null, tombstoned: typeof row.metadata?.deletedAt === 'string' };
  if (!triggerReaderStanding(session, principal)) return false;
  const spaceKind = spaceKinds
    ? row.spaceId ? spaceKinds.get(row.spaceId) ?? null : null
    : row.spaceId ? (await triggerReaderSpaceKinds(row.projectId, [row.spaceId])).get(row.spaceId) ?? null : null;
  return triggerReaderStanding({ ...session, spaceKind }, principal);
}
