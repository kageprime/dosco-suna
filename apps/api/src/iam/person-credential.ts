/**
 * Whether the caller holds the person's full identity: a browser session, or an
 * unscoped personal access token. Every other credential — a project-scoped
 * PAT, an agent session, a service account, a workspace key, a third-party
 * `kortix_oat_` OAuth token, a sandbox API key — is automation or a narrowed
 * stand-in for the person, never the person.
 *
 * Callers: the `token.personal.*` leaves (a credential can never turn itself
 * into a wider or longer-lived bearer than the one it holds) and the
 * change-request merge's `allow_secrets` override (only a person lands a key
 * the secret check flagged).
 */
import type { Actor } from './actor';

export function actsAsFullIdentity(authType: string | undefined, actor: Actor): boolean {
  const credential = actor.credential;
  if (authType === 'supabase') return credential.kind === 'jwt';
  if (authType === 'pat') return credential.kind === 'pat' && credential.projectId === null;
  return false;
}
