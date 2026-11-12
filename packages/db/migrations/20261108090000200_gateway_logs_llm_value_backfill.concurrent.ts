// Migration: gateway_logs_llm_value_backfill  (NON-TRANSACTIONAL -- batched data pass)
//
// batched-dml: one walk over the heap in page ranges, two short committed
// statements per range. Measured read-only on prod (2026-11-09, 1% sample):
// ~70% of the 4.1 M rows carry `servedModel` (written since 2026-10-05),
// ~40% carry `usageEstimated` (since 2026-10-27). Every row a statement
// touches leaves its predicate (the column becomes non-NULL), so a rerun
// after a failure fills only what is left.
//
// KRTX-4023, step 2 of the promotion. Fills the columns
// 20261108090000000_gateway_logs_served_model_usage_estimated.sql added, from
// the metadata keys the gateway writer has always carried:
//
//   served_model    <- metadata->>'servedModel'   (hooks.ts persistGatewayTrace)
//   usage_estimated <- metadata->>'usageEstimated' = 'true'
//                     (simple-handler.ts emit: `estimated || !reported`)
//
// Rows without the keys keep NULL: the readers treat a NULL column exactly as
// a missing metadata key (session-model-usage.ts falls back to
// requested/resolved_model; llm-value.ts coalesces the flag to false) — the
// pre-promotion behavior, so NULL is always a correct final state. Keys whose
// jsonb value is null are also skipped (they read NULL, same final state), so
// every pass's predicate strictly shrinks.
//
// Readers keep reading metadata until this pass ran: migrations run before the
// new pods start, so by the time the column-reading code serves traffic, this
// pass has healed every row the OLD writer produced before it. The fill
// trigger (20261108090000100) is installed BEFORE this pass: every insert
// from the moment the trigger exists — the whole potentially-long backfill,
// and every later deploy window — is lifted at insert; this pass heals only
// the history that predates the trigger, and its predicate skips rows the
// trigger already filled.

export const shorthands = undefined;

// One walk over the heap in physical order, BLOCKS pages per statement.
// Measured read-only on prod (2026-11-09, 4.1 M rows, 528 K pages): a Tid
// Range Scan over 5,000 pages (~35 K rows) reads in ~230 ms. The earlier
// shape (`where log_id in (select ... limit 5000)`) restarted a sequential
// scan at page 0 on every batch and then fetched the batch by random uuid,
// ~2.5 h on prod: past the 45 min deploy-prod migrate job. A range walk reads
// every page once, so the pass is linear in the table size.
const BLOCKS = 2000;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // pgm.db.query, not pgm.sql: pgm.sql() is queued until up() returns, so a
  // timeout set through it would not govern the passes below.
  await pgm.db.query(`set lock_timeout = '5s'`);
  await pgm.db.query(`set statement_timeout = '5min'`);

  // Pages that exist when the walk starts. A row written later is filled at
  // insert by the trigger 20261108090000100 installed, so the walk never has
  // to chase the end of the table. An updated row's new version that lands
  // in a later range already fails the predicates below, so no row is
  // touched twice.
  const { rows } = await pgm.db.query(`
    select (pg_relation_size('kortix.gateway_request_logs')
            / current_setting('block_size')::int)::bigint as pages
  `);
  const pages = Number(rows[0].pages);

  for (let from = 0; from < pages; from += BLOCKS) {
    const range = `ctid >= '(${from},0)'::tid and ctid < '(${from + BLOCKS},0)'::tid`;

    // Strix CWE-1284 (LOW finding on the PR): the two CONCURRENTLY builds
    // below index requested_model / resolved_model / served_model as btree
    // tuple members (max ~2.7 KB). A historical row written by the old writer
    // (which bounded nothing) could carry an oversized model string and fail
    // the BUILD with 54000, leaving an INVALID index. Bound history to the
    // same 255 bytes per string the writer applies. Must run BEFORE the index
    // builds (20261108090000300 / 20261108090000400), which it does by order.
    // Uses the shared byte-bound helper kortix.clip_text_bytes created by
    // 20261108090000000 (walks whole code points against the byte budget --
    // never a mid-character cut -- with the scaled estimate in bigint, so a
    // huge text value cannot overflow int4 and block this migration).
    await pgm.db.query(`
      update kortix.gateway_request_logs
         set requested_model = kortix.clip_text_bytes(requested_model, 255),
             resolved_model  = kortix.clip_text_bytes(resolved_model, 255)
       where ${range}
         and (octet_length(requested_model) > 255 or octet_length(resolved_model) > 255)
    `);

    // Row locks only, 5s budget: writers never queue behind a statement. Each
    // statement is its own committed transaction, so the walk is resumable
    // (a rerun skips filled rows) and keeps the table writable throughout.
    await pgm.db.query(`
      update kortix.gateway_request_logs
         set served_model = kortix.clip_text_bytes(metadata->>'servedModel', 255),
             usage_estimated = (metadata->>'usageEstimated') = 'true'
       where ${range}
         and ((served_model is null and metadata ? 'servedModel'
               and metadata->>'servedModel' is not null)
           or (usage_estimated is null and metadata ? 'usageEstimated'
               and metadata->>'usageEstimated' is not null))
    `);
  }
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
