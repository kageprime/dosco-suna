/**
 * Google Antigravity models on the user's own Google subscription.
 *
 * A model of the `antigravity` provider runs through Google Antigravity
 * infrastructure with the session user's own Google subscription credentials,
 * straight to Google: these models never go through the managed LLM gateway
 * and use no Dosco credits. A model ref is `antigravity/<id>`.
 *
 * This file is bundled by standalone workers and CLI tools, so it imports nothing.
 */

export const ANTIGRAVITY_PROVIDER_ID = 'antigravity' as const;

/** The provider's display name. */
export const ANTIGRAVITY_PROVIDER_NAME = 'Google Antigravity';

/** Google Antigravity's supported reasoning effort levels. */
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORTS)[number];

export interface StoredAntigravityAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  plan?: string;
}

/**
 * Parses raw Antigravity auth input. Supports:
 * 1. Raw bearer token or API key (`ya29...`, `AIzaSy...`, `Bearer ...`)
 * 2. Google OAuth credentials JSON (`~/.gemini/oauth_creds.json`: `access_token`, `refresh_token`, `expiry_date`)
 * 3. Wrapped Antigravity JSON (`{ antigravity: { access, refresh, expires } }`)
 */
export function parseAntigravityAuth(value: string | null | undefined): StoredAntigravityAuth | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Handle raw token or key (non-JSON) directly
  if (!trimmed.startsWith('{')) {
    return {
      type: 'bearer',
      access: trimmed.replace(/^Bearer\s+/i, ''),
      expires: Date.now() + 365 * 24 * 3600 * 1000,
    };
  }

  try {
    const parsed = JSON.parse(trimmed);
    const auth = parsed.antigravity ?? parsed.google ?? parsed;
    if (auth && typeof auth === 'object') {
      const access = (auth.access ?? auth.access_token)?.toString().trim();
      const refresh = (auth.refresh ?? auth.refresh_token)?.toString().trim();
      const expires =
        typeof auth.expires === 'number'
          ? auth.expires
          : typeof auth.expiry_date === 'number'
          ? auth.expiry_date
          : undefined;
      const email = auth.email ?? auth.id_token_email;
      const plan = auth.plan;

      if (access || refresh) {
        return {
          type: auth.type ?? 'oauth',
          access,
          refresh,
          expires,
          email,
          plan,
        };
      }
    }
    return null;
  } catch {
    return {
      type: 'bearer',
      access: trimmed.replace(/^Bearer\s+/i, ''),
      expires: Date.now() + 365 * 24 * 3600 * 1000,
    };
  }
}

export interface AntigravityModel {
  /** The Antigravity model identifier (e.g., 'gemini-3.8-flash'). */
  readonly id: string;
  readonly name: string;
  /** Resolved model ID. */
  readonly resolved: string;
  readonly description: string;
  /** Default reasoning effort level for this model. */
  readonly defaultEffort?: AntigravityEffort;
  /** Display badge in model selector: 'new' | 'notice' | 'unavailable'. */
  readonly badge?: 'new' | 'notice' | 'unavailable';
  /** Whether the model is currently unavailable or in private preview. */
  readonly unavailable?: boolean;
  /** Maximum context window in tokens. */
  readonly context: number;
  /** Maximum output tokens. */
  readonly output: number;
}

/**
 * Verified Antigravity model catalog matching the user's active Antigravity environment.
 */
export const ANTIGRAVITY_MODELS: readonly AntigravityModel[] = [
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    resolved: 'gemini-4-argon',
    description: 'Frontier multi-modal flagship with dynamic tool calling and deep reasoning',
    defaultEffort: 'medium',
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    resolved: 'gemini-3.8-flash',
    description: 'Ultra-fast low-latency thinking model with deep reasoning effort',
    defaultEffort: 'high',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-opus-5.5',
    name: 'Claude Opus 5.5',
    resolved: 'claude-opus-5-5',
    description: 'Anthropic frontier partner reasoning model served via Antigravity',
    defaultEffort: 'medium',
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    resolved: 'claude-sonnet-5-5',
    description: 'High-throughput frontier coding partner model served via Antigravity',
    defaultEffort: 'medium',
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Medium)',
    resolved: 'gpt-oss-120b-medium',
    description: 'High-parameter open-weights reasoning model hosted on Antigravity',
    defaultEffort: 'medium',
    badge: 'notice',
    context: 128_000,
    output: 16_000,
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    resolved: 'gemini-4-carbon',
    description: 'Next-generation ultra-scale architecture (preview / gated)',
    unavailable: true,
    badge: 'unavailable',
    context: 2_000_000,
    output: 64_000,
  },
];

export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.8-flash';

/** `antigravity/<id>` -> `<id>`; null for a ref of another provider. */
export function antigravityModelId(ref: string | null | undefined): string | null {
  const raw = (ref ?? '').trim();
  const prefix = `${ANTIGRAVITY_PROVIDER_ID}/`;
  if (!raw.startsWith(prefix)) return null;
  return raw.slice(prefix.length) || null;
}

export function isAntigravityModelRef(ref: string | null | undefined): boolean {
  return antigravityModelId(ref) !== null;
}
