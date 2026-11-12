/**
 * Google Antigravity OAuth flows.
 *
 * 1. Authorization Code + PKCE (popup/redirect) — the supported product flow on
 *    the Antigravity public client. Google rejects web redirect URIs on this
 *    client, so the flow uses a loopback redirect (`http://localhost:…/oauth-callback`)
 *    that the user pastes back into the product.
 * 2. Device Authorization Grant (RFC 8628) — kept for compatibility only; Google
 *    rejects all probed public clients with `invalid_client`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config';
import { discoverAntigravityProject } from '../llm-gateway/credentials/antigravity-cloudcode';

const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Antigravity public installed-app client (also used by the Antigravity IDE).
// The client ID is public; the client SECRET is not committed — it comes from
// GOOGLE_ANTIGRAVITY_CLIENT_SECRET (encrypted env, Heroku config).
const DEFAULT_GOOGLE_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_REDIRECT_URI = 'http://localhost:51121/oauth-callback';

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
].join(' ');

export interface AntigravityRedirectChallenge {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
  codeVerifier: string;
}

export interface AntigravityDeviceChallenge {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
}

export type AntigravityPollResult =
  | { status: 'pending' }
  | { status: 'failed'; error: string }
  | { status: 'authorized'; authJson: string };

function getGoogleClientId(): string {
  return config.GOOGLE_ANTIGRAVITY_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID;
}

function getGoogleClientSecret(): string | undefined {
  return config.GOOGLE_ANTIGRAVITY_CLIENT_SECRET || undefined;
}

/** The redirect (code) flow cannot exchange without the client secret. */
function requireGoogleClientSecret(): string {
  const secret = getGoogleClientSecret();
  if (!secret) {
    throw new Error(
      'Google Antigravity is not configured: GOOGLE_ANTIGRAVITY_CLIENT_SECRET is missing',
    );
  }
  return secret;
}

function getRedirectUri(): string {
  return config.GOOGLE_ANTIGRAVITY_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { codeVerifier: verifier, codeChallenge: challenge };
}

export function buildAntigravityAuthorizeUrl(input: {
  state: string;
  codeChallenge: string;
  redirectUri?: string;
}): string {
  const clientId = getGoogleClientId();
  const redirectUri = input.redirectUri || getRedirectUri();
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GOOGLE_SCOPES);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeAntigravityCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri?: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}> {
  const clientId = getGoogleClientId();
  const clientSecret = requireGoogleClientSecret();
  const redirectUri = input.redirectUri || getRedirectUri();

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(`Google Antigravity token exchange failed (${res.status}): ${errorText}`);
  }

  return (await res.json()) as any;
}

export async function antigravityAuthJsonFromTokens(tokens: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}): Promise<string> {
  const email = extractEmailFromIdToken(tokens.id_token);
  const project = await discoverAntigravityProject(tokens.access_token).catch(() => null);
  const authData: Record<string, unknown> = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token || '',
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    email: email || undefined,
    plan: 'pro',
    project: project || undefined,
  };
  return JSON.stringify({ antigravity: authData }, null, 2);
}

/**
 * Step 1: Request device authorization code from Google OAuth 2.0.
 */
export async function startAntigravityDeviceAuth(): Promise<AntigravityDeviceChallenge> {
  const clientId = getGoogleClientId();
  const body = new URLSearchParams({
    client_id: clientId,
    scope: GOOGLE_SCOPES,
  });

  const res = await fetch(GOOGLE_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    if (res.status === 401 && errorText.includes('invalid_client')) {
      throw new Error('Google OAuth device authorization requires a Google Cloud TV/Limited Input client. Connect Google Antigravity by pasting your Antigravity token or credentials instead.');
    }
    throw new Error(`Failed to start Google Antigravity device authorization (${res.status}): ${errorText}`);
  }

  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_url?: string;
    expires_in?: number;
    interval?: number;
  };

  if (!data.device_code || !data.user_code) {
    throw new Error('Google did not return a valid device code');
  }

  return {
    verificationUrl: data.verification_url || 'https://www.google.com/device',
    userCode: data.user_code,
    deviceAuthId: data.device_code,
    intervalMs: Math.max(data.interval ?? 5, 1) * 1000,
  };
}

/**
 * Step 2: Poll Google token endpoint until user approves device code or code expires.
 */
export async function pollAntigravityDeviceAuth(input: {
  deviceAuthId: string;
  userCode: string;
}): Promise<AntigravityPollResult> {
  const clientId = getGoogleClientId();
  const clientSecret = getGoogleClientSecret();

  const params = new URLSearchParams({
    client_id: clientId,
    device_code: input.deviceAuthId,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });

  if (clientSecret) {
    params.set('client_secret', clientSecret);
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorJson = (await res.json().catch(() => null)) as { error?: string; error_description?: string } | null;
    const errorCode = errorJson?.error;

    if (errorCode === 'authorization_pending' || errorCode === 'slow_down' || res.status === 428) {
      return { status: 'pending' };
    }

    if (errorCode === 'expired_token') {
      return { status: 'failed', error: 'Google device authorization code expired. Please try again.' };
    }

    if (errorCode === 'access_denied') {
      return { status: 'failed', error: 'Google authorization request was denied.' };
    }

    return {
      status: 'failed',
      error: errorJson?.error_description || errorCode || `Google authorization failed (${res.status})`,
    };
  }

  const tokens = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    token_type?: string;
  };

  if (!tokens.access_token) {
    return { status: 'failed', error: 'Google did not return an access token' };
  }

  const email = extractEmailFromIdToken(tokens.id_token);

  const authData: Record<string, unknown> = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token || '',
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    email: email || undefined,
    plan: 'pro',
  };

  const authJson = JSON.stringify({ antigravity: authData }, null, 2);
  return { status: 'authorized', authJson };
}

function extractEmailFromIdToken(idToken?: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
