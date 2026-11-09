// Migration: gateway_logs_project_time_covering_v3  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// CREATE INDEX CONCURRENTLY cannot run in a transaction; see
// 20261107145000000_gateway_logs_project_time_covering_v2.concurrent.ts for
// the rules of this file type (one concurrent operation, IF NOT EXISTS,
// generous lock_timeout).
//
// Why (KRTX-4449): GET /v1/projects/:id/gateway/sources (the
// `listProjectGatewaySourceSpend` aggregate, apps/api/src/shared/session-costs.ts)
// reads session_id and account_id out of every row of the project's window:
// session_id drives the source attribution join to project_sessions, the
// `count(distinct session_id)` rollup and the CostScope predicate
// (`account_id = $reader OR session_id IN (the project's sessions)`),
// account_id is the predicate's other arm. Neither column is in
// idx_gateway_logs_project_time_covering_v2's INCLUDE list, so every row of
// the window is still fetched from the wide heap (the request/response jsonb
// pair makes those rows ~1-2 KB). The company's own workspace polls this
// route every 5 minutes; as its 24-hour log volume grew, the poll's latency
// grew with it (Better Stack ClickHouse: 24 h of p95 729 ms -> 3.8 s,
// 2026-11-06 -> 2026-11-07) — the same disease KRTX-4022 fixed on the
// sibling /gateway/series route.
//
// This index is the v2 index plus those two columns. The old index is dropped
// by 20261107164458570: this one serves every query it served. session_id is
// a short text column and account_id a uuid, so the btree tuple size guard
// (metadata bounded to 2000 bytes, see buildGatewayTraceRow) is untouched.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_gateway_logs_project_time_covering_v3
      on kortix.gateway_request_logs (project_id, created_at) include (
        session_id,
        account_id,
        ok,
        billing_mode,
        final_cost_precise,
        upstream_cost_precise,
        input_tokens,
        output_tokens,
        latency_ms,
        actor_user_id,
        provider,
        resolved_model,
        cached_tokens,
        cache_write_tokens,
        metadata
      )
  `);
};

export const down = false;
