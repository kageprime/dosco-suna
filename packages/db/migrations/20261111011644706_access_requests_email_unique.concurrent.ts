// Migration: access_requests_email_unique  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// One waitlist row per address (KRTX-4699): POST /v1/access/request-access
// replayed an identical submission and inserted a duplicate row every time —
// the writer (apps/api/src/access-control/index.ts) had no conflict path. The
// endpoint now inserts with ON CONFLICT DO NOTHING, which needs this unique
// index on the normalized email it already writes (trim().lowercase() since
// the handler was born — this is the table's only writer). The index is a
// CONSTRAINT, not a performance index: the only reader is the waitlist
// endpoint's insert probe, so it can never flag `unused_index`.
//
// The pass first removes any duplicates history may hold (keep the earliest
// row per address — the first submission is the one DO NOTHING keeps) so the
// build cannot fail on data the pre-fix writer already duplicated.
//
// mixed-version-safe: adds an index/constraint, drops nothing; first-time
// submissions keep working under both versions. The migrate job lands while
// OLD pods (plain INSERT, the table's only writer) still serve — they drain
// for minutes after the roll (measured ~16 min on dev, learnings
// 2026-11-05T190925Z) — so a REPLAYED submission in that window raises 23505
// and answers 500 instead of 200+duplicate: the bug's own input, on a
// pre-auth waitlist route, no data lost, self-heals once the new code rolls.

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
  // Dedupe before the build: a unique CONCURRENTLY build fails on a table
  // that already holds two rows for one address. The waitlist table is small
  // (public, rate-limited endpoint; the only writer) and the statement is
  // re-run safe: with no duplicates left it deletes nothing.
  pgm.sql(`
    delete from kortix.access_requests a
     using kortix.access_requests b
     where a.email = b.email
       and (a.created_at, a.id) > (b.created_at, b.id)
  `);
  pgm.sql(`
    create unique index concurrently if not exists idx_access_requests_email
      on kortix.access_requests (email)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
