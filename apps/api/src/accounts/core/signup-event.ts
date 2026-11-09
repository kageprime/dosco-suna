import { accountInvitations } from '@kortix/db';
import { and, gt, sql } from 'drizzle-orm';

import { db } from '../../shared/db';
import { captureProductEvent } from '../../shared/product-analytics';
import { getSupabase } from '../../shared/supabase';

/** A sign-in this long after the auth user was created is not a sign-up. */
export const SIGNUP_EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Report `user_signed_up` for a person who reached Kortix with no workspace.
 *
 * WHY HERE. The event used to fire when the sign-in bootstrapped a personal
 * account. No account is created at sign-up any more (Workspaces D3), so the
 * event fires where that bootstrap ran: the first `GET /v1/accounts` (or
 * `/v1/accounts/me`) of a person with no membership, before pending invites
 * are claimed. Every client calls one of them right after sign-in, the
 * invited user included, and the Supabase auth hook is not ours on Kortix
 * cloud.
 *
 * ONCE PER PERSON. `dedupeKey: userId` gives the event a fixed uuid, and
 * PostHog keeps one event per uuid, so a repeat call by the same zero-account
 * person adds nothing. The window bounds the background work: a person whose
 * auth user is older than {@link SIGNUP_EVENT_WINDOW_MS} (an old user who left
 * every workspace) is not looked up again.
 *
 * INVITED OR SELF-SERVE. `invited` is true when an invitation to the person's
 * email was open at sign-up: that person joins a workspace someone else made
 * and never creates one, so the activation funnels count them apart. The same
 * answer goes on the person once, as `signup_kind`.
 *
 * Fire-and-forget: never awaited, never throws, never delays the request.
 */
export function reportSignupWithoutWorkspace(userId: string, now: () => number = Date.now): void {
  void (async () => {
    try {
      const { data } = await getSupabase().auth.admin.getUserById(userId);
      const user = data?.user;
      if (!user) return;
      const createdAt = user.created_at ? Date.parse(user.created_at) : Number.NaN;
      if (!Number.isFinite(createdAt) || now() - createdAt > SIGNUP_EVENT_WINDOW_MS) return;
      const provider = user.app_metadata?.provider;
      const method = typeof provider === 'string' && /^[a-z0-9_-]{1,32}$/.test(provider) ? provider : 'unknown';
      const invited = await invitedAtSignup(user.email, new Date(createdAt));
      captureProductEvent({
        userId,
        event: 'user_signed_up',
        dedupeKey: userId,
        properties: { method, invited },
        personPropertiesOnce: { signup_kind: invited ? 'invited' : 'self_serve' },
      });
    } catch {
      // Analytics only. A miss never affects the sign-in.
    }
  })();
}

/**
 * An invitation to `email` that had not expired when the person signed up.
 * Accepted invitations count: this lookup can run after the same request's
 * auto-claim stamped `accepted_at`. A declined invitation is deleted, so it
 * does not count.
 */
async function invitedAtSignup(email: string | undefined, signedUpAt: Date): Promise<boolean> {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return false;
  const [row] = await db
    .select({ inviteId: accountInvitations.inviteId })
    .from(accountInvitations)
    .where(and(sql`lower(${accountInvitations.email}) = ${normalized}`, gt(accountInvitations.expiresAt, signedUpAt)))
    .limit(1);
  return Boolean(row);
}
