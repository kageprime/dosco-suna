import {
  RUNTIME_AUDIT_SECRET_VALUE_RE,
  RUNTIME_AUDIT_STRUCTURAL_WRAPPER_KEYS,
  RUNTIME_AUDIT_SUMMARY_KEYS,
} from '@kortix/api-contract/runtime-relay';
import type { RuntimeAuditBatch, RuntimeAuditEvent } from '@kortix/api-contract/runtime-relay';
import type { auditEvents } from '@kortix/db';
import { LATE_ROW_MAX_AGE_DAYS } from './audit-archive/format';

/**
 * A batch and its events as received: each contract field may be absent or
 * malformed, so every read below validates it. A field renamed in the contract
 * stops compiling here.
 */
type ReceivedAuditBatch = { [K in keyof RuntimeAuditBatch]?: unknown };
type ReceivedAuditEvent = { [K in keyof RuntimeAuditEvent]?: unknown } & {
  initiator_actor_type?: unknown;
  initiator_actor_id?: unknown;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const EVENT_TYPE_RE = /^[a-z0-9_.:-]{1,128}$/i;
const IDENTIFIER_RE = /^[a-z0-9_.:/@-]{1,256}$/i;
const PHASE_RE = /^[a-z0-9_.:-]{1,32}$/i;
const ERROR_CODE_RE = /^[a-z0-9_.:-]{1,256}$/i;
const OUTCOMES = new Set(['success', 'failure', 'denied', 'pending']);
const INITIATOR_TYPES = new Set(['human', 'agent', 'service_account', 'system']);
/** One relay batch may carry up to this many events. Exported so the ingest
 *  route's statement chunking can default to the same number and the two ends
 *  of the boundary cannot drift apart. */
export const MAX_BATCH_SIZE = 200;
const MAX_SUMMARY_BYTES = 16_384;


type AuditInsert = typeof auditEvents.$inferInsert;

/**
 * `kortix.audit_events` is partitioned by week and keeps HOT_DAYS in PostgreSQL. An instant
 * outside [now - LATE_ROW_MAX_AGE_DAYS, now + 1 day] (a sandbox offline for days, a skewed
 * clock) would land in a week the archive already exported, or in the default partition, where
 * retention never reaches it. It is stored as the start of today (UTC) instead; the instant the
 * sandbox reported stays in `metadata.original_occurred_at`. The value is the same for every
 * re-send within the UTC day, so the unique dedupe key (source tuple + occurred_at) still
 * matches a retry.
 */
const MAX_EVENT_AGE_MS = LATE_ROW_MAX_AGE_DAYS * 86_400_000;
const MAX_EVENT_SKEW_MS = 86_400_000;

export interface RuntimeAuditScope {
  accountId: string;
  projectId: string;
  sessionId: string;
  /** Test seam: the clock the instant window is measured against. */
  now?: Date;
  /** Canonical attribution resolved from server-owned rows. Payload fields are untrusted. */
  trustedProvenance?: {
    runtimeSessionId: string | null;
    agentId: string | null;
    agentName: string | null;
    initiatorActorType: 'human' | 'agent' | 'service_account' | 'trigger' | 'channel' | 'system' | null;
    initiatorActorId: string | null;
    /** The human the session acts on behalf of (spec 2026-09-22 §2). */
    onBehalfOfUserId?: string | null;
    correlationId: string | null;
    causationId: string | null;
    delegationDepth: number;
  };
}

export interface ParsedRuntimeAuditBatch {
  accepted: number;
  values: AuditInsert[];
}

function fail(index: number, message: string): never {
  throw new Error(`events[${index}] ${message}`);
}

function optionalIdentifier(value: unknown, index: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    fail(index, `has an invalid ${field}`);
  }
  return value;
}

function sanitizeSummary(
  value: unknown,
  index: number,
  field: 'input_summary' | 'output_summary',
): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(index, `has an invalid ${field}`);
  }
  let nodes = 0;
  const originOnlyUrl = (candidate: string): string | null => {
    try {
      const parsed = new URL(candidate);
      return ['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ? parsed.origin : null;
    } catch {
      return null;
    }
  };
  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 256 || depth > 4) fail(index, `has an oversized ${field}`);
    if (candidate == null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) fail(index, `has an invalid ${field}`);
      return candidate;
    }
    if (typeof candidate === 'string') {
      if (candidate.length > 512) fail(index, `has an oversized ${field}`);
      const origin = originOnlyUrl(candidate);
      if (origin) return origin;
      if (RUNTIME_AUDIT_SECRET_VALUE_RE.test(candidate)) {
        fail(index, `has a credential-shaped ${field} value`);
      }
      return candidate;
    }
    if (Array.isArray(candidate)) fail(index, `has an invalid ${field}`);
    if (typeof candidate !== 'object') fail(index, `has an invalid ${field}`);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (!RUNTIME_AUDIT_SUMMARY_KEYS.has(key)) fail(index, `has a disallowed ${field} key: ${key}`);
      if (RUNTIME_AUDIT_STRUCTURAL_WRAPPER_KEYS.has(key)) {
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          result[key] = visit(child, depth + 1);
        }
        continue;
      }
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  const sanitized = visit(value, 0) as Record<string, unknown>;
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_SUMMARY_BYTES) {
    fail(index, `has an oversized ${field}`);
  }
  return sanitized;
}

function sanitizeMetadata(value: unknown, index: number): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(index, 'has invalid metadata');
  }
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key !== 'event_type' && key !== 'property_keys') {
      fail(index, `has a disallowed metadata key: ${key}`);
    }
  }
  if (input.event_type != null) {
    if (typeof input.event_type !== 'string' || !EVENT_TYPE_RE.test(input.event_type)) {
      fail(index, 'has invalid metadata.event_type');
    }
    result.event_type = input.event_type;
  }
  if (input.property_keys != null) {
    if (
      !Array.isArray(input.property_keys) ||
      input.property_keys.length > 64 ||
      input.property_keys.some(
        (key) => typeof key !== 'string' || !/^[a-z0-9_.:-]{1,128}$/i.test(key),
      )
    ) {
      fail(index, 'has invalid metadata.property_keys');
    }
    result.property_keys = [...input.property_keys];
  }
  return result;
}

function requiredSha256(value: unknown, index: number, field: string): string {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    fail(index, `has an invalid ${field}`);
  }
  return value;
}

function optionalSha256(value: unknown, index: number, field: string): string | null {
  if (value == null) return null;
  return requiredSha256(value, index, field);
}

function canonicalRuntimeAction(
  type: string,
  inputSummary: Record<string, unknown> | null,
): string {
  if (type !== 'message.part.updated') return `agent.${type}`;
  const part = inputSummary?.part;
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const partType = (part as Record<string, unknown>).type;
    if (partType === 'tool') return 'agent.tool.updated';
    if (typeof partType === 'string' && EVENT_TYPE_RE.test(partType)) {
      return `agent.message.part.${partType}.updated`;
    }
  }
  return `agent.${type}`;
}

/**
 * One event's contract, as received: validate every field the event carries
 * and assemble the row. `batch` is what the event inherits from its batch —
 * the fixed source tag and the harness. Throws `events[i] …` on the first
 * invalid field.
 */
function parseRuntimeAuditEvent(
  item: unknown,
  index: number,
  scope: RuntimeAuditScope,
  batch: { source: string; harness: string },
): AuditInsert {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    fail(index, 'is invalid');
  }
  const event = item as ReceivedAuditEvent;
  const { source, harness } = batch;
  const eventId = requiredSha256(event.event_id, index, 'event_id');
  const type =
    typeof event.type === 'string' && EVENT_TYPE_RE.test(event.type)
      ? event.type
      : fail(index, 'has an invalid type');
  const occurredAt = new Date(String(event.occurred_at ?? ''));
  if (
    typeof event.occurred_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      event.occurred_at,
    ) ||
    Number.isNaN(occurredAt.getTime())
  ) {
    fail(index, 'has an invalid occurred_at');
  }
  const now = scope.now ?? new Date();
  const outOfRange =
    occurredAt.getTime() < now.getTime() - MAX_EVENT_AGE_MS ||
    occurredAt.getTime() > now.getTime() + MAX_EVENT_SKEW_MS;
  const storedAt = outOfRange
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    : occurredAt;
  const outcome = event.outcome ?? 'success';
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    fail(index, 'has an invalid outcome');
  }
  const phase = event.phase ?? 'completed';
  if (typeof phase !== 'string' || !PHASE_RE.test(phase)) {
    fail(index, 'has an invalid phase');
  }
  const initiatorActorType = event.initiator_actor_type ?? null;
  if (
    initiatorActorType != null &&
    (typeof initiatorActorType !== 'string' || !INITIATOR_TYPES.has(initiatorActorType))
  ) {
    fail(index, 'has an invalid initiator_actor_type');
  }
  const delegationDepth = event.delegation_depth ?? 0;
  if (
    typeof delegationDepth !== 'number' ||
    !Number.isInteger(delegationDepth) ||
    delegationDepth < 0 ||
    delegationDepth > 100
  ) {
    fail(index, 'has an invalid delegation_depth');
  }
  const errorCode = event.error_code ?? null;
  if (errorCode != null && (typeof errorCode !== 'string' || !ERROR_CODE_RE.test(errorCode))) {
    fail(index, 'has an invalid error_code');
  }

  const inputSummary = sanitizeSummary(event.input_summary, index, 'input_summary');
  const outputSummary = sanitizeSummary(event.output_summary, index, 'output_summary');
  const reportedProvenance = {
    runtime_session_id: optionalIdentifier(
      event.runtime_session_id,
      index,
      'runtime_session_id',
    ),
    agent_id: optionalIdentifier(event.agent_id, index, 'agent_id'),
    agent_name: optionalIdentifier(event.agent_name, index, 'agent_name'),
    initiator_actor_type: initiatorActorType,
    initiator_actor_id: optionalIdentifier(event.initiator_actor_id, index, 'initiator_actor_id'),
    correlation_id: optionalIdentifier(event.correlation_id, index, 'correlation_id'),
    causation_id: optionalIdentifier(event.causation_id, index, 'causation_id'),
    delegation_depth: delegationDepth,
  };
  const trusted = scope.trustedProvenance;

  return {
    accountId: scope.accountId,
    projectId: scope.projectId,
    sessionId: scope.sessionId,
    runtimeSessionId: trusted?.runtimeSessionId ?? null,
    turnId: optionalIdentifier(event.turn_id, index, 'turn_id'),
    messageId: optionalIdentifier(event.message_id, index, 'message_id'),
    toolCallId: optionalIdentifier(event.tool_call_id, index, 'tool_call_id'),
    executionId: optionalIdentifier(event.execution_id, index, 'execution_id'),
    actorType: 'agent',
    agentId: trusted?.agentId ?? null,
    agentName: trusted?.agentName ?? null,
    initiatorActorType: trusted?.initiatorActorType ?? null,
    initiatorActorId: trusted?.initiatorActorId ?? null,
    onBehalfOfUserId: trusted?.onBehalfOfUserId ?? null,
    delegationDepth: trusted?.delegationDepth ?? 0,
    source,
    authoritativeSource: source,
    outcome,
    action: canonicalRuntimeAction(type, inputSummary),
    phase,
    resourceType: 'agent_event',
    resourceId: eventId,
    correlationId: trusted?.correlationId ?? null,
    causationId: trusted?.causationId ?? null,
    sourceLedger: 'agent_events',
    sourceRecordId: eventId,
    // One runtime emission can repeat the same phase with identical raw
    // properties. The relay assigns an occurrence UUID before durable
    // spooling, so transport retries dedupe while genuine repeats remain.
    sourceRevision: optionalIdentifier(event.source_revision, index, 'source_revision') ?? phase,
    inputSummary,
    outputSummary,
    inputSha256: requiredSha256(event.input_sha256, index, 'input_sha256'),
    outputSha256: optionalSha256(event.output_sha256, index, 'output_sha256'),
    errorCode,
    // Runtime error strings can contain prompts or provider response bodies.
    // The canonical ledger stores only the bounded error code and digests.
    errorMessage: null,
    metadata: {
      ...sanitizeMetadata(event.metadata, index),
      ...(outOfRange ? { original_occurred_at: occurredAt.toISOString() } : {}),
      provenance_trust: 'sandbox_reported',
      reported_provenance: reportedProvenance,
      harness,
    },
    occurredAt: storedAt,
  };
}

export function parseRuntimeAuditBatch(
  body: unknown,
  scope: RuntimeAuditScope,
): ParsedRuntimeAuditBatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('body must be an object');
  }
  const events = (body as ReceivedAuditBatch).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_BATCH_SIZE) {
    throw new Error(`events must contain 1 to ${MAX_BATCH_SIZE} items`);
  }
  // The daemon tags a batch with `source: 'runtime'` and the harness that
  // produced it. A daemon too old to tag it is below the runtime floor.
  const batch = body as ReceivedAuditBatch;
  const source = 'runtime';
  const harness =
    typeof batch.harness === 'string' && IDENTIFIER_RE.test(batch.harness) ? batch.harness : 'unknown';

  const values = events.map((item, index) =>
    parseRuntimeAuditEvent(item, index, scope, { source, harness }),
  );

  return { accepted: events.length, values };
}
