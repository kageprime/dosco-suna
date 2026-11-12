// Migration: peer_msg_p95_circle_indexes  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// KRTX-4729: the peer-messages send path and the multi-agent circle read
// filtered `kortix.project_sessions` on JSON metadata expressions with no
// index that can serve them --
//   `peer-messages/service.ts` `circleOf`:   `metadata->>'team_lead' IN (...)`
//     inside an OR with no project predicate, and
//   `peer-messages/service.ts` `byHandle`:   `metadata->>'agent_handle' = ...`
//     per project,
// plus the same two shapes in `team-tasks/service.ts` (handle-taken check,
// teammate list). The planner answered both with a full table scan; one send
// by agent name carried 1.7-4.4 s of DB wall (`server_timing`
// `db;dur=~1800;desc="n=~38"` on prod, 2026-11-11), and at quiet hours one or
// two such sends sat in the p95 of a ~42-request hour (1753 ms vs a 523 ms
// baseline). A BitmapOr over these two partial expression indexes plus the
// session_id/parent_session_id arms turns every branch of the resolution
// into an index probe.
//
// Partial and small on purpose: only sessions that carry the key are indexed
// (agent handles and team members), so the build and the write cost stay
// negligible.
//
// mixed-version-safe: adds two indexes, drops nothing; old code reads the
// same rows under both versions.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists idx_project_sessions_project_agent_handle
      on kortix.project_sessions (
        project_id,
        (metadata ->> 'agent_handle')
      )
      where (metadata ->> 'agent_handle') is not null
  `);
  pgm.sql(`
    create index concurrently if not exists idx_project_sessions_team_lead
      on kortix.project_sessions ((metadata ->> 'team_lead'))
      where (metadata ->> 'team_lead') is not null
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
