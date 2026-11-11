/**
 * Google Antigravity OAuth Device Authorization Grant (RFC 8628).
 *
 * Connects a Google Antigravity subscription directly via Google's device code endpoint:
 *   1. POST https://oauth2.googleapis.com/device/code -> { device_code, user_code, verification_url, interval }
 *   2. User navigates to https://www.google.com/device and enters user_code
 *   3. Poll POST https://oauth2.googleapis.com/token with grant_type=urn:ietf:params:oauth:grant-type:device_code
 *   4. Save encrypted ANTIGRAVITY_AUTH_JSON secret containing access/refresh tokens and user identity.
 */

import { config } from '../config';

const GOOGLE_DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Standard Google Cloud SDK / Antigravity device client identifier used for CLI & device grant authorization
const DEFAULT_GOOGLE_CLIENT_ID = '936475272427.apps.googleusercontent.com';
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/generative-language',
].join(' ');

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
