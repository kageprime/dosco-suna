import { eq } from 'drizzle-orm';
import { sessionSandboxes } from '@kortix/db';
import { db } from '../shared/db';

/**
 * The serviceKey == the sandbox's KORTIX_TOKEN — the bearer the daemon's
 * `/kortix/*` control routes (e.g. git/commit-push) authenticate against.
 *
 * A project-session sandbox persists it in `session_sandboxes.config`. The
 * legacy `kortix.sandboxes` rows (last written 2026-08-02) share no
 * external id with a session sandbox, so they are not read.
 */
export async function serviceKeyForExternalId(externalId: string): Promise<string | undefined> {
  const [ss] = await db
    .select({ config: sessionSandboxes.config })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  return (ss?.config as Record<string, unknown> | undefined)?.serviceKey as string | undefined;
}
