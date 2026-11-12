'use server';

import { AUTH_TIMEOUT_MESSAGE, AUTH_UPSTREAM_TIMEOUT_MS } from '@/lib/auth/submit-auth';
import { settleWithin } from '@/lib/deadline';
import { buildMobileSessionHandoffUrl } from '@/lib/auth/mobile-handoff';
import {
  resolveNewAccountReturnUrl,
  sanitizeAuthReturnUrl,
  shouldDemoteReturnUrl,
} from '@/lib/auth/return-url';
import { clearAuthBounceCookie } from '@/lib/auth/sign-out-actions';
import { resolveEmailLinkOrigin } from '@/lib/auth/email-link-origin';
import {
  AUTH_EMAIL_COOLDOWN_SECONDS,
  type EmailFlowMode,
  SIGNUPS_CLOSED_MESSAGE,
  SSO_REQUIRED_MESSAGE,
  authRateLimitCopy,
  resolveEmailFlowMode,
} from '@/lib/auth/unified-auth-flow';
import { AUTH_BOUNCE_COOKIE, parseAuthBounceOwner } from '@kortix/ui/internal/lib/onboarding/landing-destination';
import { getServerPublicEnv } from '@/lib/public-env-server';
import { AuthApiError } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { checkAccessEmail, submitAccessRequest } from '@kortix/sdk';
import { getTranslations } from '@/i18n/get-translations';
import type { UiTranslator } from '@/i18n/translator';
import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { cookies, headers } from 'next/headers';

/**
 * Who the middleware bounced to `/auth` on this browser, or `''` when the
 * bounce was unattributed (or there was no bounce at all — a visitor who typed
 * the address, or a link opened on a different device).
 */
async function readBouncedOwnerId(): Promise<string> {
  return parseAuthBounceOwner((await cookies()).get(AUTH_BOUNCE_COOKIE)?.value);
}

/**
 * The error a bounded GoTrue await resolves with when the deadline fires: a
 * real AuthApiError so every downstream check (code, message, status) sees
 * the shape it expects. Built on demand, never at module scope: this module
 * is server-only ('use server'), while `submit-auth.ts` also loads in the
 * BROWSER (the auth page imports `submitAuthForm`), where a module-scope
 * AuthApiError construction threw at module evaluation in a hardened
 * environment (KRTX-4637: auth-js's tag assignment failed on the frozen
 * instance that environment's `super()` produced) and took the auth page's
 * whole submit machinery down with it.
 */
function timeoutAuthError(): AuthApiError {
  return new AuthApiError(AUTH_TIMEOUT_MESSAGE, 503, 'timeout');
}

/**
 * A GoTrue failure as the action result. Rate limits become human copy — a
 * raw Supabase string is infrastructure text a visitor cannot act on — and the
 * raw code stays in the server log only. Anything else keeps GoTrue's
 * message, the pre-existing behavior.
 */
function authFailure(
  error: { code?: string | null; message?: string | null },
  fallback: string,
  tI18nComplete: UiTranslator,
) {
  const human = authRateLimitCopy(error, tI18nComplete);
  if (human) console.warn('[auth] rate limited', error.code);
  return { message: human || error.message || fallback };
}

function normalizeTrustedOrigin(value?: string | null): string | null {
  if (!value) return null;
  // Reject values that are clearly not a host/URL — e.g. an undecrypted dotenvx
  // ciphertext ("encrypted:...") leaking through a Vercel build that ran plain
  // `next build` without DOTENV_PRIVATE_KEY. Without this guard `new URL()`
  // throws and we silently fall back to localhost, which breaks the magic-link
  // redirect_to on every deployed environment.
  if (value.startsWith('encrypted:')) return null;
  const candidate = value.startsWith('http') ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function trustedWebOrigin(origin?: string | null): string {
  const configured =
    getServerPublicEnv().APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL;
  // resolveEmailLinkOrigin: the emailed link returns to the browsing origin
  // when it is the same site as the configured one (the PKCE verifier's jar
  // is host-scoped — KRTX-4628); otherwise the configured app URL stands.
  // Supabase's redirect-URL allowlist is the authority on where the link may
  // actually land, so trusting the request origin here cannot widen the
  // redirect surface.
  return resolveEmailLinkOrigin(normalizeTrustedOrigin(origin), normalizeTrustedOrigin(configured));
}

function mobileCallbackState(formData: FormData): string | null {
  if (formData.get('mobileCallback') !== 'true') return null;
  const state = formData.get('mobileCallbackState');
  return typeof state === 'string' && state.length > 0 ? state : null;
}

function emailRedirectUrl({
  origin,
  returnUrl,
  acceptedTerms = false,
  mobileState,
}: {
  origin: string;
  returnUrl: string;
  acceptedTerms?: boolean;
  mobileState?: string | null;
}): string {
  // This route intentionally is not an app universal-link path: the browser
  // owns the PKCE verifier and must exchange the code before bouncing the
  // resulting session to the installed app.
  const url = new URL(
    mobileState ? '/auth/mobile/callback' : '/auth/callback',
    trustedWebOrigin(origin),
  );
  url.searchParams.set('returnUrl', returnUrl);
  if (acceptedTerms) url.searchParams.set('terms_accepted', 'true');
  if (mobileState) {
    url.searchParams.set('mobile_callback', '1');
    url.searchParams.set('state', mobileState);
  }
  return url.toString();
}

/**
 * Ask the API how this email should proceed through the flow: 'signin' when
 * the account exists, 'signup' when it may register, 'closed' when signups
 * are off and the address isn't allowlisted, 'unknown' when the API can't
 * say (unreachable, rate-limited, or an older build without `mode`).
 *
 * The visitor's IP is forwarded so the API's per-IP rate limit lands on the
 * actual client rather than pooling every visitor into the web server's
 * single outbound address.
 */
async function checkEmailFlowMode(email: string): Promise<EmailFlowMode> {
  try {
    const backendUrl = getServerPublicEnv().BACKEND_URL || 'http://localhost:8008/v1';
    const requestHeaders = await headers();
    const forwardedFor = requestHeaders.get('x-forwarded-for') || requestHeaders.get('x-real-ip');
    const body = await checkAccessEmail(email, {
      backendUrl,
      headers: {
        ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
      },
      signal: AbortSignal.timeout(4_000),
    });
    return resolveEmailFlowMode(body);
  } catch {
    // Fail open — 'unknown' routes through the adaptive signup action, which
    // signs in existing users and registers new ones.
    return 'unknown';
  }
}

/* Server-side cooldown for the send actions: after a send this browser
 * remembers the address for one minute (the window the API enforces on its
 * email-sending routes, apps/api/src/auth/email-cooldown.ts), and a
 * re-submit inside the window answers "already sent" without repeating the
 * GoTrue call — GoTrue mails an unconfirmed address again on every call.
 * The window is deliberately NOT disclosed through the anonymous check-email
 * (KRTX-3504): its only honest source there is the auth DB, which has a row
 * for accounts and nothing for the rest, so a triggered send plus that
 * answer would re-open the enumeration oracle the issue closed. This cookie
 * is one visitor's own record of what already happened in this session — it
 * says nothing about any other address, so no caller can probe an account
 * with it.
 */
const AUTH_EMAIL_SENT_COOKIE = 'kortix-auth-email-sent';

/** Seconds left before this browser may send to `email` again, or null when
 * the minute is over (or no send happened in this session). */
async function sentAuthEmailCooldown(email: string): Promise<number | null> {
  const [sentEmail, sentAtRaw] = ((await cookies()).get(AUTH_EMAIL_SENT_COOKIE)?.value ?? '').split('|');
  const sentAt = Number(sentAtRaw);
  if (sentEmail !== email || !Number.isFinite(sentAt)) return null;
  const left = Math.ceil(AUTH_EMAIL_COOLDOWN_SECONDS - Math.max(0, (Date.now() - sentAt) / 1000));
  return left > 0 ? left : null;
}

/** Remember a send this visitor just made. An unwritable cookie store only
 * loses the skip: the cooldown stays enforced on the API's email routes. */
async function markAuthEmailSent(email: string): Promise<void> {
  try {
    (await cookies()).set({
      name: AUTH_EMAIL_SENT_COOKIE,
      value: `${email}|${Date.now()}`,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: AUTH_EMAIL_COOLDOWN_SECONDS,
    });
  } catch {
    console.warn('[auth] could not write the auth email cooldown cookie');
  }
}

/**
 * The unified flow's existence resolution. Never exposed as a raw endpoint to
 * the browser beyond this server action; the API behind it is rate-limited
 * per IP and returns a flow directive, not a bare "exists" flag.
 */
export async function resolveAuthMode(email: string): Promise<{ mode: EmailFlowMode }> {
  if (!email || !email.includes('@')) return { mode: 'unknown' };
  return { mode: await checkEmailFlowMode(email.trim().toLowerCase()) };
}

/**
 * Send the sign-in/sign-up email link — ONE action for both cases. While
 * signups are open the OTP sends with `shouldCreateUser: true`, so new and
 * existing addresses are treated identically and GoTrue picks the email kind.
 * A closed-signup address still gets its send — with `shouldCreateUser: false`
 * — because `closed` there covers existing accounts too (KRTX-3504): the
 * public API no longer says who holds one.
 */
export async function sendEmailCode(prevState: any, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const email = formData.get('email') as string;
  const requestedReturnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const acceptedTerms = formData.get('acceptedTerms') === 'true';
  const referralCode = formData.get('referralCode') as string | undefined;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: tI18nComplete.raw('textb00f7e3ae5e8') };
  }

  const normalizedEmail = email.trim().toLowerCase();

  const flowMode = await checkEmailFlowMode(normalizedEmail);
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }
  // KRTX-3504: `closed` covers BOTH an unknown address and an existing one —
  // an existing passwordless account must still reach its sign-in link. So the
  // send happens with `shouldCreateUser: false` (GoTrue mints nothing), and
  // every non-429 failure below answers the same neutral body as success:
  // GoTrue's not-found for an unknown address must not become this action's
  // fresh existence oracle. The sign-up door stays shut server-side; only
  // account creation is gated, never the sign-in mail.
  const closedSignups = flowMode === 'closed';

  // Resolve the return URL HERE — before it is baked into the email link. That
  // link can be opened minutes or days later, on a device that never held the
  // bounced session, so this is the LAST point at which either rule can still
  // reach it:
  //  - the send no longer knows whether the address is new (KRTX-3504: the
  //    API answers policy only, never account history), so the fresh-account
  //    half of the rule is applied where the account IS known: the verify
  //    callback re-runs it with the real `created_at`.
  //  - an ATTRIBUTED bounce cannot be matched against a signer here, because no
  //    identity exists yet — the address has not been proven. Fail closed: a
  //    path bounced from a named session does not get minted into an email.
  //    The password path can compare identities after authentication; the
  //    link must drop an attributed bounce before it leaves the browser.
  const returnUrl = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: null,
    isNewUser: false,
  })
    ? resolveNewAccountReturnUrl(requestedReturnUrl)
    : requestedReturnUrl;

  // An auth email went to this address in this browser's window: its link
  // and code still work, so answer the link step with the time left instead
  // of mailing the address again. No GoTrue call means no new PKCE verifier,
  // so the one this browser already holds still matches the mailed link.
  const emailRetryAfterSeconds = await sentAuthEmailCooldown(normalizedEmail);
  if (emailRetryAfterSeconds) {
    return {
      success: true,
      alreadySent: true,
      message: tI18nComplete.raw('authEmailAlreadySent'),
      email: normalizedEmail,
      redirectTo: returnUrl,
      codeVerifier: null,
      mode: flowMode,
      retryAfterSeconds: emailRetryAfterSeconds,
    };
  }

  const supabase = await createClient();
  const emailRedirectTo = emailRedirectUrl({
    origin,
    returnUrl,
    acceptedTerms,
    mobileState,
  });

  // Resolve presentation before the irreversible send; it must not turn a
  // delivered email into a failed submit.
  const successMessage = tI18nComplete.raw('textd7eb7cdcff7d');
  const { error } = await settleWithin(
    supabase.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo,
        shouldCreateUser: !closedSignups,
        data: referralCode
          ? {
              referral_code: referralCode.trim().toUpperCase(),
            }
          : undefined,
      },
    }),
    AUTH_UPSTREAM_TIMEOUT_MS,
    () => ({ data: { user: null, session: null }, error: timeoutAuthError() }),
  );

  if (error) {
    // A closed-signup send answers neutrally unless the refusal is a shared
    // rate limit — ANY 429, not just the code `authRateLimitCopy` recognizes
    // (GoTrue maps every 429 it returns to `over_request_rate_limit`):
    // per-IP pressure says nothing about the address, and hiding it would
    // invite blind retries against a backoff the visitor cannot see.
    const limitCopy = authRateLimitCopy(error, tI18nComplete);
    if (!closedSignups || error.status === 429 || limitCopy) {
      return {
        ...authFailure(error, 'Could not send the link', tI18nComplete),
        status: limitCopy || error.status === 429 ? 429 : error.status === 503 ? 503 : 400,
      };
    }
  }

  // A delivered send starts the window: a re-submit answers "already sent"
  // (above) instead of mailing the address again.
  if (!error) await markAuthEmailSent(normalizedEmail);

  // Hand the PKCE verifier to the browser in the RESULT, not only as a
  // Set-Cookie header: on the prod edge deployment the action's cookie writes
  // never reached the browser (a successful send left the jar empty —
  // KRTX-2095), so the mailed link's exchange failed
  // `pkce_code_verifier_not_found`. The page seeds the cookie from this value
  // — the same pattern `signInWithPassword` already uses for the session
  // tokens; no new exposure, `@supabase/ssr` stores the verifier
  // non-httpOnly by design. The value is the ssr-encoded `base64-` payload
  // under the fixed unchunked `-code-verifier` cookie; the page writes it
  // back byte-identical.
  let codeVerifier: string | null = null;
  try {
    codeVerifier =
      (await cookies()).get(`${KORTIX_SUPABASE_AUTH_COOKIE}-code-verifier`)?.value ?? null;
  } catch {
    // The cookie is a fallback for PKCE, not evidence of email delivery.
    console.warn('[auth] could not read email code verifier after successful send');
  }

  return {
    success: true,
    message: successMessage,
    email: normalizedEmail,
    redirectTo: returnUrl,
    codeVerifier,
    // The link step's copy must name what the mailbox actually receives
    // (KRTX-2195): while creation is allowed GoTrue picked the email kind, and
    // on closed signups the send was sign-in-only-if-the-account-exists —
    // `mode` tells the step which copy is honest.
    mode: flowMode,
    retryAfterSeconds: AUTH_EMAIL_COOLDOWN_SECONDS,
  };
}

export async function requestAccess(prevState: any, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const email = formData.get('email') as string;
  const company = formData.get('company') as string | undefined;
  const useCase = formData.get('useCase') as string | undefined;

  if (!email || !email.includes('@')) {
    return { message: tI18nComplete.raw('textb00f7e3ae5e8') };
  }

  try {
    const backendUrl = getServerPublicEnv().BACKEND_URL || 'http://localhost:8008/v1';
    await submitAccessRequest(
      {
        email: email.trim().toLowerCase(),
        company: company?.trim() || undefined,
        useCase: useCase?.trim() || undefined,
      },
      { backendUrl },
    );
    return {
      success: true,
      message: tI18nComplete.raw('textebab65dedf4d'),
    };
  } catch {
    return { message: tI18nComplete.raw('text00c6dcd85ab3') };
  }
}

export async function forgotPassword(_prevState: unknown, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const email = formData.get('email') as string;
  const origin = formData.get('origin') as string;

  if (!email || !email.includes('@')) {
    return { message: tI18nComplete.raw('textb00f7e3ae5e8') };
  }

  const supabase = await createClient();

  const { error } = await settleWithin(
    supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${trustedWebOrigin(origin)}/auth/reset-password`,
    }),
    AUTH_UPSTREAM_TIMEOUT_MS,
    () => ({ error: timeoutAuthError() }),
  );

  if (error) {
    // Same contract as sendEmailCode: the route turns a rate-limited refusal
    // into a 429 (with Retry-After) the browser can tell apart from success —
    // a 200 body the page cannot distinguish is how KRTX-2049 went unnoticed.
    return {
      ...authFailure(error, 'Could not send password reset email', tI18nComplete),
      status: authRateLimitCopy(error, tI18nComplete) ? 429 : error.status === 503 ? 503 : 400,
    };
  }

  return {
    success: true,
    message: tI18nComplete.raw('text150bfa8e7f53'),
  };
}

export async function resetPassword(prevState: any, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;

  if (!password || password.length < 6) {
    return { message: tI18nComplete.raw('text2005290ddda9') };
  }

  if (password !== confirmPassword) {
    return { message: tI18nComplete.raw('textb6eb82cd3300') };
  }

  const supabase = await createClient();

  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    return authFailure(error, 'Could not update password', tI18nComplete);
  }

  return {
    success: true,
    message: tI18nComplete.raw('texteb737b99ee2a'),
  };
}

export async function signInWithPassword(prevState: any, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const email = formData.get('email') as string;
  const password = formData.get('password') as string;
  const returnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  const origin = formData.get('origin') as string;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: tI18nComplete.raw('textb00f7e3ae5e8') };
  }

  if (!password || password.length < 6) {
    return { message: tI18nComplete.raw('text2005290ddda9') };
  }

  // SSO enforcement: when the domain's org has flipped `enforce_sso`, the
  // password door is closed even for pre-SSO password accounts — the IdP is
  // the only way in. Fail-open ('unknown') keeps logins working if the API is
  // briefly unreachable; the UI hides the password path independently.
  const flowMode = await checkEmailFlowMode(email.trim().toLowerCase());
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }

  const supabase = await createClient();

  const { data, error } = await settleWithin(
    supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    }),
    AUTH_UPSTREAM_TIMEOUT_MS,
    () => ({ data: { user: null, session: null }, error: timeoutAuthError() }),
  );

  if (error) {
    // Thread GoTrue's error code through so the flow — which already resolved
    // that this account exists — can say "wrong password" instead of the
    // deliberately ambiguous "Invalid login credentials".
    const code =
      (error as { code?: string }).code ||
      (error.message?.toLowerCase().includes('invalid login credentials')
        ? 'invalid_credentials'
        : null);
    const failure = authFailure(error, 'Invalid email or password', tI18nComplete);
    return { ...failure, code: authRateLimitCopy(error, tI18nComplete) ? null : code };
  }

  // Determine if new user (for analytics)
  const isNewUser = data.user && Date.now() - new Date(data.user.created_at).getTime() < 60000;
  const authEvent = isNewUser ? 'signup' : 'login';

  // Return success — let the client redirect after auth state hydrates. An
  // account this young signed up moments ago (the sign-up form ends in a
  // password sign-in), so it gets the signup destination rule, not a return URL
  // pointing at a resource that predates it. The same rule applies when the
  // return URL was bounced here from somebody ELSE's session — an existing
  // account is exactly the case `isNewUser` alone never covered.
  const finalReturnUrl = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: data.user?.id ?? null,
    isNewUser,
  })
    ? resolveNewAccountReturnUrl(returnUrl)
    : returnUrl;
  await clearAuthBounceCookie();
  const redirectUrl = new URL(finalReturnUrl, 'http://localhost');
  redirectUrl.searchParams.set('auth_event', authEvent);
  redirectUrl.searchParams.set('auth_method', 'email');

  return {
    success: true,
    redirectTo: `${redirectUrl.pathname}${redirectUrl.search}`,
    accessToken: data.session?.access_token || null,
    refreshToken: data.session?.refresh_token || null,
    mobileHandoffUrl: buildMobileSessionHandoffUrl({
      origin: trustedWebOrigin(origin),
      state: mobileState,
      accessToken: data.session?.access_token,
      refreshToken: data.session?.refresh_token,
    }),
  };
}

/**
 * Unified signup: works identically in local and cloud.
 *
 * Strategy: signUp → immediately try signInWithPassword. When Supabase
 * confirmations are off (local default, and recommended for self-host),
 * sign-in succeeds and the user is in. When confirmations are on (cloud),
 * sign-in returns `email_not_confirmed` and we surface "check your email".
 *
 * Cloud and local share this function. The only configuration-dependent
 * behavior is whether the inner signIn succeeds — driven by Supabase's
 * `enable_confirmations`, not by any billing flag.
 */
export async function signUpWithPassword(prevState: any, formData: FormData) {
  const tI18nComplete = await getTranslations('hardcodedUi.i18nComplete');
  const email = (formData.get('email') as string | null)?.trim().toLowerCase();
  const password = formData.get('password') as string;
  const confirmPassword = formData.get('confirmPassword') as string;
  const requestedReturnUrl = sanitizeAuthReturnUrl(formData.get('returnUrl') as string | undefined);
  // This is the sign-up form: unless the account turns out to already exist
  // (`alreadyExists` below), the identity about to be created cannot own
  // anything the visitor was looking at before they got here.
  const newAccountReturnUrl = resolveNewAccountReturnUrl(requestedReturnUrl);
  const origin = formData.get('origin') as string;
  const mobileState = mobileCallbackState(formData);

  if (!email || !email.includes('@')) {
    return { message: tI18nComplete.raw('textb00f7e3ae5e8') };
  }
  if (!password || password.length < 6) {
    return { message: tI18nComplete.raw('text2005290ddda9') };
  }
  if (password !== confirmPassword) {
    return { message: tI18nComplete.raw('textb6eb82cd3300') };
  }

  // Access control gate — this is the CREATE door: a brand-new address while
  // signups are closed never reaches GoTrue, and an SSO-enforced domain never
  // gets a password identity created. The gate answers policy only, so it
  // refuses every address on a closed deployment alike (KRTX-3504) — an
  // existing account signs in through the sign-in door, which never consults
  // this check.
  const flowMode = await checkEmailFlowMode(email);
  if (flowMode === 'closed') {
    return { code: 'signups_closed', message: SIGNUPS_CLOSED_MESSAGE };
  }
  if (flowMode === 'sso') {
    return { code: 'sso_required', message: SSO_REQUIRED_MESSAGE };
  }

  const supabase = await createClient();
  const emailRedirectTo = emailRedirectUrl({
    origin,
    // The confirmation link outlives the "new user" heuristic downstream, so
    // the signup rule has to be applied before it is minted, not after.
    returnUrl: newAccountReturnUrl,
    mobileState,
  });

  // GoTrue mails the confirmation again on every signUp for an unconfirmed
  // address. When this browser's window is already cooling, the address was
  // just submitted once, so skip signUp: the sign-in below still lets a
  // confirmed account in, and an unconfirmed one gets "already sent" instead
  // of one more email per click.
  const emailRetryAfterSeconds = await sentAuthEmailCooldown(email);
  const { error: signUpError } = emailRetryAfterSeconds
    ? { error: null }
    : await settleWithin(
        supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo },
        }),
        AUTH_UPSTREAM_TIMEOUT_MS,
        () => ({ data: { user: null, session: null }, error: timeoutAuthError() }),
      );

  const alreadyExists =
    !!emailRetryAfterSeconds ||
    (signUpError &&
      (signUpError.message?.toLowerCase().includes('already registered') ||
        signUpError.message?.toLowerCase().includes('already exists') ||
        signUpError.status === 422));

  if (signUpError && !alreadyExists) {
    return authFailure(signUpError, 'Could not create account', tI18nComplete);
  }

  if (!signUpError) await markAuthEmailSent(email);

  const { data: signInData, error: signInError } = await settleWithin(
    supabase.auth.signInWithPassword({
      email,
      password,
    }),
    AUTH_UPSTREAM_TIMEOUT_MS,
    () => ({ data: { user: null, session: null }, error: timeoutAuthError() }),
  );

  if (signInError) {
    if (authRateLimitCopy(signInError, tI18nComplete)) {
      return authFailure(signInError, 'Could not sign in', tI18nComplete);
    }
    if (
      signInError.message?.toLowerCase().includes('email_not_confirmed') ||
      signInError.message?.toLowerCase().includes('not confirmed')
    ) {
      return {
        success: true,
        message: tI18nComplete.raw(
          emailRetryAfterSeconds ? 'authEmailAlreadySent' : 'textac0a6f3b5c61',
        ),
        email,
        requiresEmailConfirmation: true,
        alreadySent: !!emailRetryAfterSeconds,
        retryAfterSeconds: emailRetryAfterSeconds ?? AUTH_EMAIL_COOLDOWN_SECONDS,
      };
    }
    if (alreadyExists) {
      // The signup attempt just proved the account exists AND the password is
      // wrong — hand the client a structured code so it can flip the step to
      // sign-in with honest "wrong password" copy.
      return {
        code: 'existing_account_wrong_password',
        message: tI18nComplete.raw('text6b234ac2b5d2'),
      };
    }
    return { message: signInError.message || 'Account created but could not sign in' };
  }

  // A signup enters through the landing door, which paints instantly and
  // provisions the first project behind the UI. This action used to await a
  // managed git repo create + a full starter push here (up to 90s) before it
  // could return a redirect, which blocked the sign-up form itself.
  //
  // `alreadyExists` means the address had an account and the password was
  // right — that is a sign-IN, so the visitor's own return URL still stands…
  // unless the path was bounced here from a DIFFERENT account's session. This
  // form is a real sign-in door for anyone who already has an account, which is
  // the second-paid-account case, so it needs the same identity gate the
  // sign-in action has.
  const redirectTo = shouldDemoteReturnUrl({
    bouncedOwnerId: await readBouncedOwnerId(),
    signedInUserId: signInData.user?.id ?? null,
    isNewUser: !alreadyExists,
  })
    ? newAccountReturnUrl
    : requestedReturnUrl;
  await clearAuthBounceCookie();

  return {
    success: true,
    redirectTo,
    accessToken: signInData.session?.access_token || null,
    refreshToken: signInData.session?.refresh_token || null,
    mobileHandoffUrl: buildMobileSessionHandoffUrl({
      origin: trustedWebOrigin(origin),
      state: mobileState,
      accessToken: signInData.session?.access_token,
      refreshToken: signInData.session?.refresh_token,
    }),
  };
}
