/**
 * Pure query-parsing, validation and cursor codec for
 * `GET /{workspaceId}/gateway/usage` — the cross-session, full-history spend
 * and token query over the gateway request ledger.
 *
 * Deliberately has NO DB/config/drizzle imports so it can be unit-tested
 * without booting the API env or a database (mirrors ./router/routes/usage-query.ts).
 * The SQL execution lives in ./gateway-usage-run.ts, the only place this is
 * wired to the live `gateway_request_logs` aggregation.
 *
 * Honesty contract (see ./llm-spend.ts and ./llm-value.ts): this layer never
 * blends the three money concepts. Every group and the grand total carry
 * `kortix_cost` (paid Kortix wallet spend), `provider_cost` (BYOK spend paid
 * straight to your own provider) and `total_cost = kortix_cost + provider_cost`
 * as separate labelled fields, plus `estimated_usage_value` (a list-price
 * usage ESTIMATE, not a bill) kept wholly apart from spend.
 */

/** The dimensions a usage query may group by. Any subset, combinable. */
export type UsageDimension = 'model' | 'agent' | 'source' | 'session' | 'day';

export const USAGE_DIMENSIONS: readonly UsageDimension[] = [
  'model',
  'agent',
  'source',
  'session',
  'day',
];

/** Page-size bounds for the returned GROUPS (not the ledger rows they aggregate). */
export const USAGE_GROUP_LIMIT_DEFAULT = 500;
export const USAGE_GROUP_LIMIT_MAX = 1000;

/** Rolling-window bound (days) when no absolute window is given. */
export const USAGE_DAYS_DEFAULT = 30;
export const USAGE_DAYS_MAX = 3650;

export interface GatewayUsageQuery {
  /** Absolute inclusive lower bound (created_at >= since). */
  since?: Date;
  /** Absolute exclusive upper bound (created_at < until). */
  until?: Date;
  /** Rolling window in days; set only when neither since nor until is given. */
  days?: number;
  /** Selected dimensions in request order; [] means one grand-total group. */
  groupBy: UsageDimension[];
  /** Max GROUPS returned in this page. */
  limit: number;
  /** Opaque keyset cursor from a previous page's `next_cursor`. */
  cursor?: UsageCursor;
}

/**
 * Keyset position for group pagination. Groups are ordered by total spend
 * descending with a deterministic tiebreak on the group's sort key (the
 * dimension values joined), so the ordering is total even when many groups
 * share a cost (e.g. $0). The cursor carries both halves of that order.
 */
export interface UsageCursor {
  /** total_cost of the last group on the previous page. */
  cost: number;
  /** Deterministic sort key (dimension values joined with U+001F) of that group. */
  key: string;
}

export class InvalidGatewayUsageQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidGatewayUsageQueryError';
  }
}

/** U+001F unit separator — cannot appear in a model id, agent name, source or date. */
export const SORT_KEY_SEP = '\u001f';

function parseTimestamp(raw: string, field: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidGatewayUsageQueryError(`Invalid ${field} timestamp: ${raw}`);
  }
  return date;
}

/**
 * Parse + validate the query params of `GET /gateway/usage`.
 *
 * - `since`/`until`: absolute ISO timestamps. `since` must be <= `until`.
 * - `days`: rolling window; mutually exclusive with `since`/`until` (an
 *   absolute window and a rolling window at once is ambiguous and refused).
 * - `group_by`: comma-separated subset of USAGE_DIMENSIONS, de-duplicated,
 *   order preserved. Empty/absent means a single grand-total group.
 * - `limit`: group page size, clamped to [1, USAGE_GROUP_LIMIT_MAX].
 * - `cursor`: opaque keyset token from a prior `next_cursor`.
 */
export function parseGatewayUsageQuery(query: {
  since?: string;
  until?: string;
  days?: string;
  group_by?: string;
  limit?: string;
  cursor?: string;
}): GatewayUsageQuery {
  const result: GatewayUsageQuery = { groupBy: [], limit: USAGE_GROUP_LIMIT_DEFAULT };

  const hasSince = query.since !== undefined && query.since !== '';
  const hasUntil = query.until !== undefined && query.until !== '';
  const hasDays = query.days !== undefined && query.days !== '';

  if (hasDays && (hasSince || hasUntil)) {
    throw new InvalidGatewayUsageQueryError(
      'days cannot be combined with since/until — pass an absolute window or a rolling one, not both',
    );
  }

  if (hasSince) result.since = parseTimestamp(query.since!, 'since');
  if (hasUntil) result.until = parseTimestamp(query.until!, 'until');
  if (result.since && result.until && result.since.getTime() > result.until.getTime()) {
    throw new InvalidGatewayUsageQueryError('since must not be after until');
  }

  if (hasDays) {
    const days = Number(query.days);
    if (!Number.isInteger(days) || days < 1) {
      throw new InvalidGatewayUsageQueryError(`days must be a positive integer: ${query.days}`);
    }
    result.days = Math.min(days, USAGE_DAYS_MAX);
  } else if (!hasSince && !hasUntil) {
    // No window at all → a safe rolling default, never "all history by accident".
    result.days = USAGE_DAYS_DEFAULT;
  }

  if (query.group_by !== undefined && query.group_by !== '') {
    const seen = new Set<UsageDimension>();
    for (const raw of query.group_by.split(',')) {
      const token = raw.trim();
      if (token === '') continue;
      if (!USAGE_DIMENSIONS.includes(token as UsageDimension)) {
        throw new InvalidGatewayUsageQueryError(
          `group_by must be a comma-separated subset of: ${USAGE_DIMENSIONS.join(', ')} (got "${token}")`,
        );
      }
      seen.add(token as UsageDimension);
    }
    // Request order, de-duplicated, so `--group-by source,model` reports
    // source first.
    const ordered: UsageDimension[] = [];
    for (const raw of query.group_by.split(',')) {
      const token = raw.trim() as UsageDimension;
      if (seen.has(token) && !ordered.includes(token)) ordered.push(token);
    }
    result.groupBy = ordered;
  }

  if (query.limit !== undefined && query.limit !== '') {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidGatewayUsageQueryError(`limit must be a positive integer: ${query.limit}`);
    }
    result.limit = Math.min(limit, USAGE_GROUP_LIMIT_MAX);
  }

  if (query.cursor !== undefined && query.cursor !== '') {
    result.cursor = decodeUsageCursor(query.cursor);
  }

  return result;
}

/** Encode a keyset position as an opaque base64url token. */
export function encodeUsageCursor(cursor: UsageCursor): string {
  const json = JSON.stringify({ c: cursor.cost, k: cursor.key });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** Decode a `next_cursor`. A malformed cursor is a client error, not a 500. */
export function decodeUsageCursor(raw: string): UsageCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidGatewayUsageQueryError('cursor is malformed');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { c?: unknown }).c !== 'number' ||
    !Number.isFinite((parsed as { c: number }).c) ||
    typeof (parsed as { k?: unknown }).k !== 'string'
  ) {
    throw new InvalidGatewayUsageQueryError('cursor is malformed');
  }
  return { cost: (parsed as { c: number }).c, key: (parsed as { k: string }).k };
}
