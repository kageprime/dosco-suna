import { HTTPException } from 'hono/http-exception';

// Allows one cost-explorer window scan at a time on this API process. Each of
// /v1/usage/session-costs, /cost-by-project and /cost-summary aggregates every
// gateway_request_logs row of its window and runs 4 to 6 statements in parallel
// (cost-rollups.ts), against a pool of DEFAULT_DB_POOL_MAX = 6 connections. A
// single read can therefore fill the pool, so the bound is per replica, not per
// account: reads run one after another, up to COST_READ_MAX_WAITING queue behind
// the running one and any further read is refused at once with a retryable 429
// (the workspace heatmap issues up to 25 summary reads together; the UI retries
// the 429 itself, see retryCostReadBusy in packages/ui). Waiting reads hold no connection. On
// 2026-11-13 one caller sent 149 session-costs reads in under six minutes; the
// SDK retried every 503 twice, the pool saturated and unrelated routes missed
// the 25 s request deadline (a 3 minute API-wide brownout).
//
// The permit is released when the read SETTLES, not when the request deadline
// answers 503: the deadline does not cancel the statements, so a permit freed
// at the 503 would let the pool fill with orphaned scans anyway.

export const COST_READ_CODE = 'cost_read_busy' as const;

const RETRY_AFTER_SECONDS = 5;

export const COST_READ_MAX_WAITING = 3;

let running = false;
const waiting: Array<() => void> = [];

function busy(): HTTPException {
  const body = {
    error: 'rate_limit_exceeded',
    code: COST_READ_CODE,
    message: 'Too many cost reads are queued on this server. Retry shortly.',
    retry_after_seconds: RETRY_AFTER_SECONDS,
  };
  return new HTTPException(429, {
    message: body.message,
    res: new Response(JSON.stringify(body), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': String(RETRY_AFTER_SECONDS) },
    }),
  });
}

export async function withCostReadGuard<T>(read: () => Promise<T>): Promise<T> {
  if (running) {
    if (waiting.length >= COST_READ_MAX_WAITING) throw busy();
    // The permit is handed over directly, so `running` stays true across the handoff.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  running = true;
  try {
    return await read();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running = false;
  }
}

// Drizzle builders execute on each then() call. Assimilate them once, then
// drain those same executions before a failed report returns its permit.
export function drainCostReadQueries<T extends readonly unknown[]>(queries: readonly [...T]): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>;
export async function drainCostReadQueries(queries: readonly unknown[]): Promise<unknown[]> {
  const running = queries.map((query) => Promise.resolve(query));
  try {
    return await Promise.all(running);
  } catch (error) {
    await Promise.allSettled(running);
    throw error;
  }
}
