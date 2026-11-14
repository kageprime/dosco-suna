import { gatewayRequestLogs } from '@kortix/db';
import { sql } from 'drizzle-orm';

const logs = gatewayRequestLogs;

/**
 * The ONE definition of "which model answered a gateway request" — the served
 * model, i.e. the model that produced the reply (or, on an unanswered request,
 * the model it was being served by).
 *
 * A trace records both the requested and resolved ids since the gateway started
 * writing them. An older row is read from its own columns: `resolved_model` is a
 * route id only on a Kortix-served row (on an own key or ChatGPT plan it is the
 * upstream's id), and a fallback always left a failed attempt behind.
 *
 * KRTX-4023: the served model is a real column (`served_model`, written from the
 * metadata key by the gateway writer and the backfill) so a group key over it
 * scans the covering index index-only — a jsonb expression can never join an
 * INCLUDE list. A NULL column (a row written before the promotion) falls back to
 * the same provider-based read the metadata-absent path used before traces
 * carried the key.
 *
 * Lives in the shared layer because both the per-session model usage
 * (projects/lib/session-model-usage.ts) and the cross-session usage query
 * (shared/gateway-usage-run.ts) group spend by it; keeping it single-source
 * stops a fallback model's charges from ever being misattributed to the
 * requested model that did not answer.
 */
export const servedModelSql = sql<string>`coalesce(
  ${logs.servedModel},
  case when ${logs.provider} = 'kortix' then ${logs.resolvedModel} else ${logs.requestedModel} end
)`;
