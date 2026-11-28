// Parsing + link building for the Supabase "send email" auth hook payload.
// Kept separate from the route so every branch is unit-testable without HTTP.
import { config } from '../../config';
import type { AuthEmailActionType } from './templates';

export interface SendEmailHookPayload {
  user?: { email?: string; new_email?: string | null };
  email_data?: {
    token?: string;
    token_hash?: string;
    token_new?: string;
    token_hash_new?: string;
    redirect_to?: string;
    email_action_type?: string;
    site_url?: string;
  };
}

export interface ParsedAuthEmail {
  recipient: string;
  actionType: AuthEmailActionType;
  actionUrl: string;
  token: string;
}

const ACTION_TYPES: readonly AuthEmailActionType[] = [
  'signup',
  'invite',
  'magiclink',
  'recovery',
  'email_change',
  'email_change_current',
  'email_change_new',
  'reauthentication',
];

function asActionType(raw: string | undefined): AuthEmailActionType | null {
  const value = (raw || '').toLowerCase() as AuthEmailActionType;
  return ACTION_TYPES.includes(value) ? value : null;
}

/** Public Supabase origin for the verification link — see buildVerifyUrl(). */
export function authVerifyBaseUrl(): string {
  return (config.SUPABASE_PUBLIC_URL || config.SUPABASE_URL || '').trim();
}

/**
 * Build the verification link GoTrue would have put in its own template:
 * `<auth-origin>/auth/v1/verify?token=<hash>&type=<type>&redirect_to=<url>`.
 *
 * `verifyBaseUrl` must be the PUBLICLY reachable Supabase origin. On a
 * self-host box the API talks to Supabase over an internal Docker hostname
 * (`http://supabase-kong:8000`) that no mail client can resolve, which is
 * exactly what SUPABASE_PUBLIC_URL exists to correct.
 */
export function buildVerifyUrl(input: {
  verifyBaseUrl: string;
  tokenHash: string;
  actionType: AuthEmailActionType;
  redirectTo?: string;
}): string {
  const base = input.verifyBaseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    token: input.tokenHash,
    type: input.actionType,
  });
  if (input.redirectTo) params.set('redirect_to', input.redirectTo);
  return `${base}/auth/v1/verify?${params.toString()}`;
}

/** The web callbacks that verify an email token hash themselves. */
const TOKEN_HASH_CALLBACK_PATHS = ['/auth/callback', '/auth/mobile/callback'];

/**
 * The signup confirmation link. GoTrue's verify endpoint answers a PKCE signup
 * with a code that expires 5 minutes after the SIGNUP started (its flow state
 * clock; magic links count from the click instead), so a confirmation opened
 * later lands on "link expired" although the address was just confirmed. The
 * web callback verifies the token hash itself, valid for the email OTP's whole
 * lifetime. Any other redirect target keeps GoTrue's verify link.
 */
function buildSignupUrl(input: { verifyBaseUrl: string; tokenHash: string; redirectTo?: string }): string {
  const target = input.redirectTo ? URL.parse(input.redirectTo) : null;
  if (!target || !TOKEN_HASH_CALLBACK_PATHS.includes(target.pathname)) {
    return buildVerifyUrl({ ...input, actionType: 'signup' });
  }
  target.searchParams.set('token_hash', input.tokenHash);
  target.searchParams.set('type', 'signup');
  return target.toString();
}

/**
 * Normalize the hook payload into everything needed to render and address one
 * email. Returns a reason string instead of throwing so the route can answer
 * with a precise 400.
 */
export function parseSendEmailHookPayload(
  payload: SendEmailHookPayload,
  verifyBaseUrl: string,
): { ok: true; email: ParsedAuthEmail } | { ok: false; reason: string } {
  const data = payload.email_data;
  if (!data) return { ok: false, reason: 'missing email_data' };

  const actionType = asActionType(data.email_action_type);
  if (!actionType) {
    return { ok: false, reason: `unsupported email_action_type "${data.email_action_type ?? ''}"` };
  }

  // A change of address confirms from the NEW mailbox with its own token; every
  // other action (including the confirmation sent to the current address)
  // confirms from the address already on the account.
  const usesNewAddress = actionType === 'email_change_new';
  const recipient = (
    usesNewAddress ? payload.user?.new_email || payload.user?.email : payload.user?.email
  )?.trim();
  if (!recipient) return { ok: false, reason: 'missing user email' };

  const token = (usesNewAddress ? data.token_new || data.token : data.token)?.trim() || '';
  if (actionType === 'reauthentication') {
    if (!token) return { ok: false, reason: 'missing token' };
    return { ok: true, email: { recipient, actionType, actionUrl: '', token } };
  }

  const tokenHash = (
    usesNewAddress ? data.token_hash_new || data.token_hash : data.token_hash
  )?.trim();
  if (!tokenHash) return { ok: false, reason: 'missing token_hash' };
  if (!verifyBaseUrl) return { ok: false, reason: 'no public Supabase URL configured' };

  const redirectTo = data.redirect_to || data.site_url || undefined;
  return {
    ok: true,
    email: {
      recipient,
      actionType,
      actionUrl:
        actionType === 'signup'
          ? buildSignupUrl({ verifyBaseUrl, tokenHash, redirectTo })
          : buildVerifyUrl({ verifyBaseUrl, tokenHash, actionType, redirectTo }),
      token,
    },
  };
}
