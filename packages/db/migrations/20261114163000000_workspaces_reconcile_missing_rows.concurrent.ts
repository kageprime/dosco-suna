// Migration: workspaces_reconcile_missing_rows  (NON-TRANSACTIONAL -- batched data pass)
//
// Workspaces Release 2a (design: .agents/skills/learnings/work/workspaces/design.md §4).
// Reconciles every account that holds NO row of kortix.workspaces at all
// (legacy_account_id = the account), and every account with a project row that
// has no row of its own (workspace_id = project_id). Invariants I9 and I12 report
// each one. The next files add twin foreign keys into kortix.workspaces: a new row
// that references a project with no workspaces row would fail its commit, and a
// later VALIDATE would fail on the old ones. Reconcile first (learning
// 2026-08-19T182307Z).
//
// Read-only, 2026-11-11: prod 1 account (created 2026-04, no project row, no
// member); dev 1 account with 4 project rows and no row at all; staging 0. The
// R1 reconcile body that could drop a row was replaced by 20261111135934314.
//
// batched-dml: each statement reconciles at most 500 accounts and commits on
// its own (pgm.noTransaction). Row locks only: the reconcile takes FOR NO KEY
// UPDATE on each account row of its batch and writes only kortix.workspaces.
// The candidate scan is one anti-join over accounts (~50k rows) per batch.
//
// Idempotent: a rerun finds no account without a row and does nothing.
//
// Mixed-version deploy: the R1 image never names kortix.workspaces; the R2a
// image reads it through the store, which already answers from the table.
//
// ROLL BACK: none needed (the rows are what the R1 triggers would write on the
// account's next change).

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
  // Keyset on account_id, so an account the reconcile cannot fill is never read twice.
  let after = '00000000-0000-0000-0000-000000000000';
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (!UUID_RE.test(after)) throw new Error(`workspaces_reconcile_missing_rows: bad keyset ${after}`);
    const { rows } = await pgm.db.query(`
      with missing as (
        select a.account_id
          from kortix.accounts a
         where a.account_id > '${after}'::uuid
           and (not exists (select 1 from kortix.workspaces w where w.legacy_account_id = a.account_id)
                -- or a project row of the account has no row of its own: the
                -- project-side twin keys would refuse every new reference to it.
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
