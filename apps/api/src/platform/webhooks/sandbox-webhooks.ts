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
 *    registration (`POST /v1/webhooks`).
 *  - E2B: events `sandbox.lifecycle.*` (`created`, `updated`, `killed`,
 *    `paused`, `resumed`, `checkpointed`), v2 snake_case payload
 *    (`sandbox_id`, `type`, `timestamp`). Deliveries carry `e2b-signature` —
 *    base64(sha256(signatureSecret + rawBody)) with `=` padding stripped —
 *    where signatureSecret is chosen at registration
 *    (`POST api.e2b.app/events/webhooks`).
 *
 * Signature header/format specifics for each provider are confirmed against a
 * live delivery at deploy time — see verify* below. Until the matching secret is
 * configured the endpoints are inert (503) and the reaper alone keeps billing
 * correct, so enabling webhooks is purely an upgrade in latency, never a
 * correctness dependency.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';
import { recordWebhookEvent } from '../../billing/services/webhook-concurrency';
import {
  reconcileSandboxStoppedByExternalId,
  reconcileSandboxRemovedByExternalId,
} from '../../projects/sandbox-reaper';

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

/**
 * Svix-style verification (Daytona). signedContent = `${id}.${timestamp}.${body}`;
 * secret is base64 after the `whsec_` prefix; signature header is one or more
 * space-separated `v1,<base64>` entries.
 */
export function verifySvix(
  rawBody: string,
  secret: string,
  parts: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
): boolean {
  const { id, timestamp, signature } = parts;
  if (!id || !timestamp || !signature) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  const candidates = signature
    .split(' ')
    .map((p) => (p.includes(',') ? p.split(',')[1] : p))
    .filter(Boolean);
  return candidates.some((c) => safeEqual(c, expected));
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
    // (incident 2026-08-17T20:40:03Z, session 0fc6897a). The reaper's poll
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

/** Daytona webhook handler. `headers` is a case-insensitive getter. */
export async function handleDaytonaWebhook(
  rawBody: string,
  getHeader: (name: string) => string | undefined,
): Promise<WebhookResult> {
  const secret = config.DAYTONA_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'daytona webhook not configured' } };

  const ok = verifySvix(rawBody, secret, {
    id: getHeader('webhook-id') ?? getHeader('svix-id'),
    timestamp: getHeader('webhook-timestamp') ?? getHeader('svix-timestamp'),
    signature: getHeader('webhook-signature') ?? getHeader('svix-signature'),
  });
  if (!ok) return { status: 401, body: { error: 'invalid signature' } };

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const externalId: string | undefined = event?.id ?? event?.data?.id ?? event?.sandboxId;
  const eventType: string = event?.event ?? event?.type ?? '';
  const newState: string | undefined = event?.newState ?? event?.state ?? event?.data?.state;
  if (!externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const dedupId = `daytona:${getHeader('webhook-id') ?? `${externalId}:${newState}:${event?.updatedAt ?? ''}`}`;
  const fresh = await recordWebhookEvent(dedupId, eventType || 'sandbox.event').catch(() => true);
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  const outcome = classifyLifecycle(newState, eventType);
  const res = await applySandboxLifecycle(externalId, outcome);
  return { status: 200, body: { ok: true, externalId, ...res } };
}

/** Platinum webhook handler. */
export async function handlePlatinumWebhook(
  rawBody: string,
  getHeader: (name: string) => string | undefined,
): Promise<WebhookResult> {
  const secret = config.PLATINUM_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'platinum webhook not configured' } };

  const sig =
    getHeader('x-platinum-signature') ??
    getHeader('platinum-signature') ??
    getHeader('x-signature') ??
    getHeader('webhook-signature');
  if (!verifyHmacSha256(rawBody, secret, sig)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const externalId: string | undefined = event?.id ?? event?.sandbox_id ?? event?.data?.id ?? event?.sandboxId;
  const eventType: string = event?.event ?? event?.type ?? '';
  const newState: string | undefined = event?.state ?? event?.new_state ?? event?.newState ?? event?.data?.state;
  if (!externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const dedupId = `platinum:${event?.id ?? `${externalId}:${eventType}:${event?.timestamp ?? ''}`}`;
  const fresh = await recordWebhookEvent(dedupId, eventType || 'sandbox.event').catch(() => true);
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  const outcome = classifyLifecycle(newState, eventType);
  const res = await applySandboxLifecycle(externalId, outcome);
  return { status: 200, body: { ok: true, externalId, ...res } };
}

/**
 * E2B delivery verification. `e2b-signature` = base64(sha256(signatureSecret
 * + rawBody)) with `=` padding stripped. E2B's own docs once showed a
 * URL-safe transform, but live deliveries carry standard base64 (`+`, `/`) —
 * so compare the stripped standard form, accepting the URL-safe form too.
 * Header name is `e2b-signature` (the dashboard's `x-e2b-signature` label is
 * a known docs bug — accept both).
 */
export function verifyE2bSignature(
  rawBody: string,
  secret: string,
  headerValue: string | undefined,
): boolean {
  if (!headerValue) return false;
  const standard = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const stripped = standard.replace(/=+$/, '');
  const urlSafe = stripped.replace(/\+/g, '-').replace(/\//g, '_');
  const candidates = headerValue
    .split(/[\s,]+/)
    .map((p) => p.replace(/^(sha256=|v1=)/i, '').trim())
    .filter(Boolean);
  return candidates.some((c) => safeEqual(c, stripped) || safeEqual(c, urlSafe));
}

/**
 * E2B lifecycle type → billing action. The six known v2 types are mapped
 * explicitly: only `killed` is terminal (`removed` closes billing and drops
 * the record, matching what the reaper does on a gone box). `paused` parks
 * the box as `stopped` (resumable, record kept); everything else is acked as
 * a no-op — our own provision/resume paths own the active direction.
 * Unknown types fall back to the shared classifier on the event label.
 */
export function classifyE2bLifecycle(
  eventType: string,
  eventLabel?: string | null,
): SandboxLifecycleOutcome {
  const t = (eventType ?? '').toLowerCase();
  if (t.includes('kill')) return 'removed';
  if (t.includes('paus')) return 'stopped';
  if (
    t.includes('creat') ||
    t.includes('updat') ||
    t.includes('resum') ||
    t.includes('checkpoint')
  )
    return 'noop';
  return classifyLifecycle(null, eventLabel ?? eventType);
}

/** E2B webhook handler. `headers` is a case-insensitive getter. */
export async function handleE2bWebhook(
  rawBody: string,
  getHeader: (name: string) => string | undefined,
): Promise<WebhookResult> {
  const secret = config.E2B_WEBHOOK_SECRET;
  if (!secret) return { status: 503, body: { error: 'e2b webhook not configured' } };

  const sig = getHeader('e2b-signature') ?? getHeader('x-e2b-signature');
  if (!verifyE2bSignature(rawBody, secret, sig)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  // v2 snake_case payload (`sandbox_id`, `type`, `timestamp`); tolerate the
  // older camelCase shape E2B's docs still show in places.
  const externalId: string | undefined =
    event?.sandbox_id ?? event?.sandboxId ?? event?.data?.sandbox_id ?? event?.id;
  const eventType: string = event?.type ?? event?.event ?? '';
  const eventLabel: string | undefined = event?.event_label ?? event?.eventLabel;
  if (!externalId) return { status: 200, body: { ok: true, ignored: 'no sandbox id' } };

  const dedupId = `e2b:${getHeader('e2b-delivery-id') ?? `${externalId}:${eventType}:${event?.timestamp ?? ''}`}`;
  const fresh = await recordWebhookEvent(dedupId, eventType || 'sandbox.event').catch(() => true);
  if (!fresh) return { status: 200, body: { ok: true, deduped: true } };

  const outcome = classifyE2bLifecycle(eventType, eventLabel);
  const res = await applySandboxLifecycle(externalId, outcome);
  return { status: 200, body: { ok: true, externalId, ...res } };
}
