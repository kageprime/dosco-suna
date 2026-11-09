// Migration: gateway_logs_project_time_covering_v3_drop  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// The CONCURRENTLY escape hatch: DROP INDEX CONCURRENTLY cannot run inside a
// transaction. See
// 20261108090000300_gateway_logs_project_time_covering_v4.concurrent.ts for
// the full house rules for this file class.
//
// KRTX-4023, the second step of the replace dance started in
// 20261108090000300: v4 (same (project_id, created_at) keys, every scalar
// INCLUDE column of v3 plus requested_model and the promoted
// served_model/usage_estimated pair, `metadata` dropped) is built; v3 is now
// dominated by it for every scalar it carried — every plan v3 could serve
// with its scalar columns, v4 serves index-only too, and keeping both doubles
// the write amplification on the hottest write path in the database (one
// index entry per gateway request).
//
// mixed-version-safe: v4 was built first (20261108090000300), so at every
// moment from here on an index carrying every SCALAR column of v3 exists.
// The one v3 column v4 does not carry is the `metadata` jsonb itself: after
// the promotion its only aggregated keys (servedModel, usageEstimated) are
// read from the promoted columns, and no project-window aggregate reads
// `metadata` anymore — the per-row and per-session reads that still do (the
// logs list page, fallbackFrom/attemptFailures) were never index-only
// regardless (page-scoped or session-scoped windows). The planner matches
// indexes by definition, never by name, and no code references index names,
// so old and new code are served identically before and after this drop.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per call: a multi-statement string is an implicit
  // transaction block, which defeats noTransaction() (see the sibling
  // migration's header).
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_gateway_logs_project_time_covering_v3`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
