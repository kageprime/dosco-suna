/**
 * The house-rules safety header every new migration is born with, rendered
 * here for BOTH scaffolds that write it: `create-migration.ts` (hand-written
 * .sql and the .concurrent.ts escape hatch) and `generate.ts` (drizzle's raw
 * output).
 *
 * `migrate:create` has pre-filled this since the zero-downtime policy landed,
 * but `migrate:generate` did not — it renamed drizzle's file through unchanged.
 * So every GENERATED migration was born failing squawk's
 * `require-timeout-settings`, and only passed if the author happened to paste
 * the header in by hand. One that didn't (20260805030712000_enterprise_
 * entitled_flag.sql) merged red and then failed the lint on every unrelated PR
 * afterwards, because the gate's exemption list is a fixed snapshot.
 *
 * One module renders the header, so the two scaffolds can no longer drift;
 * scripts/generate-safety-header.test.ts asserts the rendered text.
 */

/**
 * The shared preamble: the house `set` statements plus the caller's
 * checklist. The checklist text lives with each render below.
 */
function safetyHeader(name: string, checklist: string): string {
  return `-- Migration: ${name}
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

${checklist}`;
}

/** The header prepended to drizzle's raw output by `pnpm migrate:generate`. */
export function generatedMigrationHeader(name: string): string {
  return safetyHeader(
    name,
    `-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list \`migrate:create\` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       \`pnpm migrate:create <slug> --concurrent\`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

`,
  );
}

/** The full template written by `pnpm migrate:create <slug>` (plain .sql). */
export function handWrittenMigrationHeader(name: string): string {
  return safetyHeader(
    name,
    `-- Expand/contract checklist -- delete lines that don't apply, keep the rest honest:
--   [ ] New/renamed column is nullable OR has a DEFAULT (no bare NOT NULL on an
--       existing populated table without a prior backfill migration).
--   [ ] New index: use \`pnpm migrate:create ${name}_index --concurrent\`
--       instead of a plain CREATE INDEX in this file -- see the .concurrent.ts
--       escape hatch. A plain CREATE INDEX on an existing table blocks writes
--       for the duration of the build.
--   [ ] Adding a FK or a new constraint on an existing table: add it NOT VALID,
--       VALIDATE CONSTRAINT in a follow-up migration (constraint-missing-not-valid).
--   [ ] Dropping/renaming a column, table, constraint, unique index, or enum
--       value: confirm every code path that reads or writes it was removed in
--       a PRIOR deploy that is ALREADY LIVE (expand -> contract, never both in
--       one migration). If old code MIGHT still be running when this deploys,
--       add the line below (this is enforced -- CI fails without it on any
--       DROP/RENAME/ALTER ... TYPE/DROP NOT NULL):
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Adding an enum value (ALTER TYPE ... ADD VALUE): a faked/rebaselined
--       environment can silently skip it (see the prod sandbox_provider
--       "platinum" 22P02 incident) -- this is enforced, add:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- Write your SQL below.
`,
  );
}

/** The full template written by `pnpm migrate:create <slug> --concurrent`. */
export function concurrentScaffold(name: string): string {
  return `// Migration: ${name}  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around \`pnpm migrate\` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). \`pgm.noTransaction()\` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     \`lock_timeout\` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the one lock a CONCURRENTLY build holds
//     (ShareUpdateExclusive on the table) only excludes other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails \`pnpm --filter @kortix/db lint\`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add \`// mixed-version-safe: <justification>\` above \`up\` if this drops
//     something old code might still read (see MIGRATIONS.md).

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
  pgm.sql(\`set lock_timeout = '180s'\`);
  pgm.sql(\`set statement_timeout = '30min'\`);
  pgm.sql(\`
    create index concurrently if not exists idx_TODO_ON_TODO_TABLE
      on kortix.TODO_TABLE (TODO_COLUMN)
  \`);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
`;
}
