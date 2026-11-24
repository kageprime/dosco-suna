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
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high', 'extra', 'max'] as const;
export type AntigravityEffort = (typeof ANTIGRAVITY_EFFORTS)[number];

export interface StoredAntigravityAuth {
  type?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  email?: string;
  plan?: string;
  /** Cloud Code companion project the subscription bills through (`loadCodeAssist`). */
  project?: string;
  /** Optional OAuth client credentials carried in imported `~/.gemini/oauth_creds.json`. */
  client_id?: string;
  client_secret?: string;
}

/**
 * Epoch ms an access-only (bearer) paste stays usable. Google OAuth access
 * tokens live about an hour; a paste without a refresh token cannot be
 * refreshed, so it must not pretend to be durable.
 */
const BEARER_ACCESS_TTL_MS = 50 * 60 * 1000;

/**
 * Parses raw Antigravity auth input. Supports:
 * 1. Google OAuth credentials JSON (`~/.gemini/oauth_creds.json`: `access_token`, `refresh_token`, `expiry_date`)
 * 2. Wrapped Antigravity JSON (`{ antigravity: { access, refresh, expires, project } }`)
 * 3. A raw `ya29…` bearer access token (usable for ~1h, never refreshed)
 *
 * Anything else — API keys (`AIza…`), arbitrary garbage — is rejected with
 * `null`: Antigravity models run on Cloud Code with the user's own Google
 * sign-in, and neither kind of value can ever work there.
 */
export function parseAntigravityAuth(value: string | null | undefined): StoredAntigravityAuth | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
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
        const project = typeof auth.project === 'string' ? auth.project : undefined;
        const clientId = (auth.client_id ?? auth.clientId)?.toString().trim() || undefined;
        const clientSecret = (auth.client_secret ?? auth.clientSecret)?.toString().trim() || undefined;

        if (access || refresh) {
          return {
            type: auth.type ?? 'oauth',
            ...(access ? { access } : {}),
            ...(refresh ? { refresh } : {}),
            ...(expires !== undefined ? { expires } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(plan !== undefined ? { plan } : {}),
            ...(project !== undefined ? { project } : {}),
            ...(clientId ? { client_id: clientId } : {}),
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  const raw = trimmed.replace(/^Bearer\s+/i, '').trim();
  if (/^ya29[.\-_A-Za-z0-9]/.test(raw) && raw.length >= 25) {
    return { type: 'bearer', access: raw, expires: Date.now() + BEARER_ACCESS_TTL_MS };
  }
  return null;
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
  /**
   * Live Cloud Code effort variants this model serves (verified via
   * `fetchAvailableModels` 2026-11-12: ids are `resolved-{low|medium|high}`).
   * Absent → `resolved` is the exact wire id and no suffix is ever appended
   * (bare ids like `gemini-2.5-flash`, or one-variant ids like
   * `gpt-oss-120b-medium`).
   */
  readonly efforts?: readonly AntigravityEffort[];
  /**
   * Send `resolved` exactly as written. Google's Claude ids on Antigravity are
   * fixed strings: the 4.6 ids end in `-thinking` and the 5.5 ids have no
   * suffix. Appending an effort tier to any of them makes Cloud Code answer
   * 404. Live `fetchAvailableModels` data may not override this either.
   */
  readonly pinWireId?: boolean;
  /** Display badge in model selector: 'new' | 'notice' | 'unavailable'. */
  readonly badge?: 'new' | 'notice' | 'unavailable';
  /** Whether the model is currently unavailable or in private preview. */
  readonly unavailable?: boolean;
  /** Maximum context window in tokens. */
  readonly context: number;
  /** Maximum output tokens. */
  readonly output: number;
}

const EFFORT_SUFFIX_RE = /-(low|medium|high|extra|max|tiered)$/;

/** Legacy model ids retained so older sessions continue to resolve without cluttering the picker. */
export const ANTIGRAVITY_LEGACY_ALIASES: Record<string, string> = {
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-3-flash': 'gemini-3-flash',
};

/**
 * The exact Cloud Code model id to send for a catalog entry: `resolved`, plus
 * the entry's default effort tier when the model serves effort variants and
 * `resolved` does not already carry one.
 */
export function antigravityWireModelId(entry: AntigravityModel): string {
  if (entry.pinWireId || !entry.efforts?.length || EFFORT_SUFFIX_RE.test(entry.resolved)) return entry.resolved;
  return `${entry.resolved}-${entry.defaultEffort ?? 'medium'}`;
}

/**
 * Curated Antigravity model catalog matching the live Cloud Code environment.
 * Connected accounts refresh dynamically from `/v1internal:fetchAvailableModels`.
 */
export const ANTIGRAVITY_MODELS: readonly AntigravityModel[] = [
  {
    id: 'gemini-4-neon',
    name: 'Gemini 4 Neon',
    resolved: 'gemini-4-neon',
    description: 'Latest frontier Gemini 4 reasoning and coding model with selectable effort',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'extra'],
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gemini-4-argon',
    name: 'Gemini 4 Argon',
    resolved: 'gemini-4-argon',
    description: 'Frontier multi-modal flagship with dynamic tool calling and deep reasoning',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'extra'],
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gemini-4-hydrogen',
    name: 'Gemini 4 Hydrogen',
    resolved: 'gemini-4-hydrogen',
    description: 'High-capacity deep-reasoning flagship with extra thinking budget',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high', 'extra'],
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'orchestrator-neon',
    name: 'Orchestrator (Neon)',
    resolved: 'orchestrator-neon',
    description: 'Dedicated multi-step agent orchestrator powered by Gemini 4 Neon',
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    resolved: 'gemini-3.8-flash',
    description: 'Fast low-latency thinking model with selectable reasoning effort',
    defaultEffort: 'medium',
    efforts: ['low', 'medium', 'high'],
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-opus-5.5',
    name: 'Claude Opus 5.5',
    resolved: 'claude-opus-5-5',
    description: 'Anthropic frontier partner reasoning model served via Antigravity',
    pinWireId: true,
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    resolved: 'claude-sonnet-5-5',
    description: 'High-throughput frontier coding partner model served via Antigravity',
    pinWireId: true,
    badge: 'new',
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    resolved: 'claude-opus-4-6-thinking',
    description: 'Anthropic reasoning model served via Antigravity with fixed thinking id',
    pinWireId: true,
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    resolved: 'claude-sonnet-4-6-thinking',
    description: 'Anthropic coding partner served via Antigravity with fixed thinking id',
    pinWireId: true,
    context: 1_000_000,
    output: 64_000,
  },
  {
    id: 'gpt-oss-120b',
    name: 'GPT-OSS 120B (Medium)',
    resolved: 'gpt-oss-120b-medium',
    description: 'High-parameter open-weights reasoning model hosted on Antigravity',
    badge: 'notice',
    context: 128_000,
    output: 16_000,
  },
  {
    id: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    resolved: 'gemini-4-carbon',
    description: 'Next-generation ultra-scale architecture',
    badge: 'new',
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
