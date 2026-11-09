// Migration: drop_gateway_logs_project_time_covering_v2  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// CREATE INDEX CONCURRENTLY cannot run in a transaction; see
// 20261107145000000_gateway_logs_project_time_covering_v2.concurrent.ts for
// the rules of this file type (one concurrent operation, IF NOT EXISTS,
// generous lock_timeout).
//
// KRTX-4449 widens the project-led covering index with session_id and
// account_id (the gateway sources aggregate reads them out of every row;
// KRTX-4022's v2 index left them out). The superseded index goes; v3 serves
// every query v2 served. mixed-version-safe: no released query reads
// idx_gateway_logs_project_time_covering_v2 by name; every aggregate it
// served plans over v3, which carries a superset of its columns.

// mixed-version-safe: the index is replaced by
// idx_gateway_logs_project_time_covering_v3 (20261107164457464), which
// carries every v2 column plus session_id and account_id; no query degrades.
export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_gateway_logs_project_time_covering_v2');
};

export const down = false;
