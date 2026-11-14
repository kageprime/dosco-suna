// Migration: workspaces_reconcile_nil_uuid_account  (NON-TRANSACTIONAL -- batched data pass)
//
// Workspaces Release 2a (design: .agents/skills/learnings/work/workspaces/design.md §4).
// Repeats 20261114163000000_workspaces_reconcile_missing_rows with a keyset that includes the
// first uuid. That pass started its keyset at '00000000-0000-0000-0000-000000000000' and read
// `account_id > after`, so an account whose id IS that uuid was never a candidate. Read-only,
// 2026-11-14: on prod the one account with no kortix.workspaces row (invariants I9 and I12) has
// that id; on dev the same id holds 4 project rows with no row of their own, so every new row
// that references one of those projects fails the twin foreign key at commit. The pass found 0
// candidates on dev and wrote nothing.
//
// batched-dml: each statement reconciles at most 500 accounts and commits on its own
// (pgm.noTransaction). Row locks only: the reconcile takes FOR NO KEY UPDATE on each account row
// of its batch and writes only kortix.workspaces. The candidate scan is one anti-join over
// accounts (~50k rows) per batch.
//
// Idempotent: a rerun finds no account without a row and does nothing.
//
// Mixed-version deploy: the R1 image never names kortix.workspaces; the R2a image reads it
// through the store, which already answers from the table.
//
// ROLL BACK: none needed (the rows are what the R1 triggers would write on the account's next
// change).

export const shorthands = undefined;

const BATCH = 500;
const MAX_BATCHES = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the statements below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);
  // Keyset on account_id. The first batch has no lower bound, so the first uuid is a candidate.
  let after: string | null = null;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (after !== null && !UUID_RE.test(after)) throw new Error(`workspaces_reconcile_nil_uuid_account: bad keyset ${after}`);
    const lowerBound = after === null ? 'true' : `a.account_id > '${after}'::uuid`;
    const { rows } = await pgm.db.query(`
      with missing as (
        select a.account_id
          from kortix.accounts a
         where ${lowerBound}
           and (not exists (select 1 from kortix.workspaces w where w.legacy_account_id = a.account_id)
                -- or a project row of the account has no row of its own: the
                -- project-side twin keys refuse every new reference to it.
                or exists (select 1 from kortix.projects p
                            where p.account_id = a.account_id
                              and not exists (select 1 from kortix.workspaces w where w.workspace_id = p.project_id)))
         order by a.account_id
         limit ${BATCH}
      ),
      done as (
        select m.account_id, kortix.workspaces_reconcile_account(m.account_id) as ok
          from missing m
      )
      select max(account_id::text) as last, count(*)::int as n from done
    `);
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) break;
    after = String(rows[0].last);
    if (n < BATCH) break;
  }
};

export const down = false;
