/**
 * Provider sandbox-lifecycle webhook ingress — the DETERMINISTIC billing-close
 * path. The reaper sweep (projects/sandbox-reaper.ts) is the backstop; these
 * webhooks make billing close the instant a provider reports a box stopped,
 * instead of up to a sweep-interval later.
 *
 *  - Daytona: org-level webhook, events `sandbox.created` / `sandbox.state.updated`
 *    (payload carries `id`, `newState`). Deliveries are signed Svix-style
 *    (`webhook-id` / `webhook-timestamp` / `webhook-signature`, secret `whsec_…`).
 *  - Platinum: events `sandbox.created` / `sandbox.state_updated` / `sandbox.deleted`,
 *    each HMAC-SHA-256 signed with the per-webhook secret shown once at
 *    registration (`POST /v1/webhooks`). Its replay guard keys on a hash of the
 *    signed body bytes only — never an unsigned header or the payload `id`,
 *    which names the sandbox (see handlePlatinumWebhook).
 *
 * Signature header/format specifics for each provider are confirmed against a
 * live delivery at deploy time — see verify* below. Until the matching secret is
 * configured Platinum ingress is not registered (Daytona stays inert with 503),
 * and the reaper alone keeps billing
 * correct, so enabling webhooks is purely an upgrade in latency, never a
 * correctness dependency.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { recordWebhookEvent } from '../../billing/services/webhook-concurrency';
import {
  reconcileSandboxStoppedByExternalId,
  reconcileSandboxRemovedByExternalId,
} from '../../projects/sandbox-reaper';
import { bindIntegrationPrincipal } from '../../shared/audit-scope';
import { readStandardWebhookHeaders, verifyStandardWebhook } from '../../lib/webhooks/standard-webhooks';

export type SandboxLifecycleOutcome = 'stopped' | 'removed' | 'noop';

/**
 * Map a provider state / event name to the billing action. Only the terminal
 * directions matter for correctness — a `started`/`created`/transitional event
 * is acked as a no-op (our own resume/provision paths own the active direction).
 */
export function classifyLifecycle(state: string | undefined | null, eventType: string): SandboxLifecycleOutcome {
  const s = (state ?? '').toLowerCase();
  const e = (eventType ?? '').toLowerCase();
  if (e.includes('delet') || e.includes('destroy')) return 'removed';
  if (['destroyed', 'deleted', 'removed', 'lost', 'failed-start'].includes(s)) return 'removed';
  if (['stopped', 'stopping', 'archived', 'archiving'].includes(s)) return 'stopped';
  return 'noop';
}

/** Constant-time hex/base64 compare that never throws on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Plain HMAC-SHA-256 over the raw body (Platinum). Accepts the signature header
 * with or without a `sha256=` / `v1=` prefix, in hex.
 */
export function verifyHmacSha256(rawBody: string, secret: string, headerValue: string | undefined): boolean {
  if (!headerValue) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  // A header may carry multiple comma/space-separated candidates (`v1=…,…`).
  const candidates = headerValue
    .split(/[\s,]+/)
    .map((p) => p.replace(/^(sha256=|v1=)/i, '').trim())
    .filter(Boolean);
  return candidates.some((c) => safeEqual(c.toLowerCase(), expected.toLowerCase()));
}

/** Apply the terminal outcome to billing + DB (idempotent, shared with the reaper). */
export async function applySandboxLifecycle(
  externalId: string,
  outcome: SandboxLifecycleOutcome,
): Promise<{ action: SandboxLifecycleOutcome; changed: boolean }> {
  if (!externalId) return { action: 'noop', changed: false };
  if (outcome === 'stopped') {
    // An unsolicited observation, and `classifyLifecycle` folds the
    // TRANSITIONAL `stopping` / `archiving` into it — so while a turn is open
    // this must be confirmed by a second observation before it parks the box
    // (incident 2026-08-17T20:40:03Z, a prod session). The reaper's poll
    // supplies that second observation within one pass.
    const changed = await reconcileSandboxStoppedByExternalId(externalId, new Date(), {
      confirmMidTurnStop: true,
    });
    return { action: 'stopped', changed };
  }
  if (outcome === 'removed') {
    const changed = await reconcileSandboxRemovedByExternalId(externalId);
    return { action: 'removed', changed };
  }
  return { action: 'noop', changed: false };
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

type GetHeader = (name: string) => string | undefined;

/** The payload's field fallbacks, per provider. */
interface SandboxWebhookFields {
  externalId?: string;
  eventType: string;
  newState?: string;
}

/** One parsed delivery, handed to the provider's replay-key builder. */
type SandboxWebhookDelivery = {
  fields: SandboxWebhookFields;
  event: any;
  rawBody: string;
  getHeader: GetHeader;
};

/** Everything one provider's delivery needs that the other does differently. */
interface SandboxWebhookProvider {
  /** Names the 503 body, the audit principal, and the dedup-key prefix. */
  name: string;
  secret: () => string | undefined;
  verify: (rawBody: string, secret: string, getHeader: GetHeader) => boolean;
  readFields: (event: any) => SandboxWebhookFields;
  /** The replay-guard key, or null to acknowledge WITHOUT claiming a key. */
  dedupId: (ctx: SandboxWebhookDelivery) => string | null;
}

const DAYTONA_WEBHOOK: SandboxWebhookProvider = {
  name: 'daytona',
  secret: () => config.DAYTONA_WEBHOOK_SECRET,
  verify: (rawBody, secret, getHeader) => {
    // Daytona signs with Svix (Standard Webhooks). The helper also rejects a
    // timestamp more than 5 minutes off, so a captured delivery cannot be replayed.
    const headers = readStandardWebhookHeaders(getHeader);
    return verifyStandardWebhook({ rawBody, secret, headers });
  },
  readFields: (event) => ({
    externalId: event?.id ?? event?.data?.id ?? event?.sandboxId,
    eventType: event?.event ?? event?.type ?? '',
    newState: event?.newState ?? event?.state ?? event?.data?.state,
  }),
  // A payload that names no sandbox id is acknowledged before any key is claimed.
  dedupId: ({ fields, event, getHeader }) =>
    fields.externalId
      ? `daytona:${getHeader('webhook-id') ?? `${fields.externalId}:${fields.newState}:${event?.updatedAt ?? ''}`}`
      : null,
};

const PLATINUM_WEBHOOK: SandboxWebhookProvider = {
  name: 'platinum',
  secret: () => config.PLATINUM_WEBHOOK_SECRET,
  verify: (rawBody, secret, getHeader) => {
    const sig =
      getHeader('x-platinum-signature') ??
      getHeader('platinum-signature') ??
      getHeader('x-signature') ??
      getHeader('webhook-signature');
    return verifyHmacSha256(rawBody, secret, sig);
  },
  readFields: (event) => ({
    externalId: event?.id ?? event?.sandbox_id ?? event?.data?.id ?? event?.sandboxId,
    eventType: event?.event ?? event?.type ?? '',
    newState: event?.state ?? event?.new_state ?? event?.newState ?? event?.data?.state,
  }),
  dedupId: ({ rawBody }) => {
    // Key the replay guard on the SIGNED body bytes only, via a hash of them
    // (CWE-345, KRTX-4502). Distinct deliveries carry distinct signed bodies
    // (every Platinum delivery is stamped with its own `ts`), so they get distinct
    // keys — a `removed` after a `stopped` is never folded into an earlier
    // event's key, which is what the deleted `platinum:${externalId}:${eventType}:
    // ${event.timestamp ?? ''}` fallback did (it read a `timestamp` field no
    // Platinum delivery has), and what keying on the payload `id` would do (that
    // field IS the sandbox id). It is also the only material the HMAC covers:
    // keying on the unsigned `webhook-id` header instead would let a captured
    // signed body be replayed with a fresh header value for a fresh key
    // (CWE-294), while a byte-identical replay always hashes to the key already
    // claimed — deduped. A delivery this handler cannot map to a sandbox still
    // claimed its key and is acknowledged once: a body we do not understand is
    // never re-applied as "already ran" (applySandboxLifecycle no-ops on a
    // missing id).
    return `platinum:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`;
  },
};

/**
 * The ONE provider-delivery pipeline: secret → signature → principal → JSON
 * guard → field extraction → replay claim → classify → apply → respond. The
 * per-provider differences are the SandboxWebhookProvider entry; a new provider
 * is one table entry, not a second pipeline.
 */
async function handleSandboxWebhook(
  provider: SandboxWebhookProvider,
  rawBody: string,
  getHeader: GetHeader,
): Promise<WebhookResult> {
  const secret = provider.secret();
  if (!secret) return { status: 503, body: { error: `${provider.name} webhook not configured` } };
  if (!provider.verify(rawBody, secret, getHeader)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }
  bindIntegrationPrincipal(provider.name);

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const fields = provider.readFields(event);
  const dedupId = provider.dedupId({ fields, event, rawBody, getHeader });
  if (!dedupId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const fresh = await recordWebhookEvent(dedupId, fields.eventType || 'sandbox.event').catch(() => true);
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  if (!fields.externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };
  const outcome = classifyLifecycle(fields.newState, fields.eventType);
  const res = await applySandboxLifecycle(fields.externalId, outcome);
  return { status: 200, body: { ok: true, externalId: fields.externalId, ...res } };
}

/** Daytona webhook handler. `headers` is a case-insensitive getter. */
export const handleDaytonaWebhook = (rawBody: string, getHeader: GetHeader): Promise<WebhookResult> =>
  handleSandboxWebhook(DAYTONA_WEBHOOK, rawBody, getHeader);

/** Platinum webhook handler. */
export const handlePlatinumWebhook = (rawBody: string, getHeader: GetHeader): Promise<WebhookResult> =>
  handleSandboxWebhook(PLATINUM_WEBHOOK, rawBody, getHeader);
