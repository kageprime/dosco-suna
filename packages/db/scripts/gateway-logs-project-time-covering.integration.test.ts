/**
 * The project-led gateway aggregates (gateway budgets memberRows/projectAgg,
 * budgetSpends, gateway overview, gateway series, gateway sources, gateway
 * sessions) scanned kortix.gateway_request_logs by (project_id, created_at)
 * and heap-fetched every wide jsonb row because idx_gateway_logs_project_time
 * carries none of the aggregated columns. Prod (Better Stack 2346961,
 * 2026-10-18 07:54): the 15-minute budgets poll of a busy project crossed the
 * 25 s statement timeout (503 + error page) while its neighbors ran 2-14 s
 * every poll — the latency is heap I/O.
 * idx_gateway_logs_project_time_covering (20261020080000000) carried every
 * column those aggregates read — until the LLM retail valuation (KRTX-3560,
 * 2026-10-27) composed its per-row case into the same scans: it reads
 * provider, resolved_model, cached_tokens, cache_write_tokens and the
 * usage-was-estimated flag, and the breakdown's group key reads the served
 * model. The flag and the served model lived only inside `metadata` — a jsonb
 * extraction no INCLUDE list can carry, and a btree expression key never
 * serves an index-only scan (verified on PG 17.6: the same predicate over a
 * plain column plans Index Only, over an expression key it plans Bitmap Heap)
 * — so the plans silently fell back to heap-fetching the wide rows (KRTX-4023:
 * whole-dashboard 25 s deadline storms). The two values are now REAL columns
 * (20261108090000000, written by the gateway writer and backfilled by
 * 20261108090000200) and the covering indexes carry them as plain INCLUDE
 * columns: the project-time index is v4 (20261108090000300 — v3's scalar
 * columns, `metadata` replaced by the promoted pair, requested_model back for
 * the breakdown's fallback arm), so the plans are index-only again.
 *
 * The assertion reads the live catalog and the live planner (EXPLAIN), never
 * source text: each aggregate's exact shape must plan as an Index Only Scan
 * over the covering index, and dropping the index must flip the plan back to
 * the heap path — so the test fails without the migration. The sibling
 * covering indexes are dropped in the suite's own database clone first, so
 * the assertion pins index-only ELIGIBILITY (which columns the index carries),
 * not which competitor wins the planner's cost race at sandbox scale.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

/**
 * The per-row LLM retail value case, verbatim from
 * apps/api/src/shared/llm-value.ts `rowLlmValueSql` (KRTX-3560, 2026-10-27).
 * KRTX-4023: this case reads the promoted `usage_estimated` column — written
 * by the gateway writer, the 20261108090000200 backfill and the fill trigger
 * 20261108090000100; the pre-promotion read was
 * `metadata->>'usageEstimated'`, a jsonb expression no INCLUDE list can carry
 * and a btree expression key never serves index-only — plus provider,
 * resolved_model, cached_tokens and cache_write_tokens. Until those live in
 * the covering index, every gateway analytics scan that composes this case
 * heap-fetches its whole (project_id, created_at) window. The `p` prefix
 * renders the same case the way production's query builder emits it inside a
 * join (the sources aggregate aliases the log table).
 */
const llmValueCase = (p = '') => `case when
  ${p}provider in ('openai', 'openai-codex') and ${p}resolved_model = 'gpt-6.1-sol'
  and ${p}ok and not coalesce(${p}usage_estimated, false)
  and ${p}input_tokens >= 0 and ${p}output_tokens >= 0
  and ${p}cached_tokens >= 0 and ${p}cache_write_tokens >= 0
  and ${p}cached_tokens + ${p}cache_write_tokens <= ${p}input_tokens
  then ((${p}input_tokens - ${p}cached_tokens - ${p}cache_write_tokens)
    * case when ${p}input_tokens > 272000 then 4::numeric else 2::numeric end
    + ${p}cached_tokens * case when ${p}input_tokens > 272000 then 0.2::numeric else 0.1::numeric end
    + ${p}cache_write_tokens * case when ${p}input_tokens > 272000 then 5::numeric else 2.5::numeric end
    + ${p}output_tokens * case when ${p}input_tokens > 272000 then 15::numeric else 10::numeric end) / 1000000 end`;

const LLM_VALUE_CASE = llmValueCase();

/** llm-value.ts `llmValueFields`, verbatim: the per-row case never appears raw
 *  in a reporting select — it is always wrapped in sum()/count(), so every
 *  column it reads must live in the covering index for the plan to stay
 *  index-only. */
const LLM_VALUE_FIELDS = `
         sum(${LLM_VALUE_CASE})::float8 as estimated_usage_value,
         count(${LLM_VALUE_CASE})::int as priced_requests,
         count(*) filter (where ok and ${LLM_VALUE_CASE} is null)::int as unpriced_requests`;

/** llm-spend.ts `rowBilledByKortixSql` and the aggregates every rollup
 *  composes from it (`totalSpendSql`, `kortixBilledSpendSql`,
 *  `providerBilledSpendSql`), verbatim. */
const BILLED_BY_KORTIX = `coalesce(
             billing_mode,
             case when final_cost_precise > 0 then 'credits' else 'none' end
           ) = 'credits'`;
const TOTAL_SPEND = `coalesce(sum(final_cost_precise + (case when ${BILLED_BY_KORTIX} then 0 else upstream_cost_precise end)), 0)::float8`;
const KORTIX_SPEND = `coalesce(sum(final_cost_precise), 0)::float8`;
const PROVIDER_SPEND = `coalesce(sum(case when ${BILLED_BY_KORTIX} then 0 else upstream_cost_precise end), 0)::float8`;

/** GET /v1/projects/:id/gateway/overview (gateway-spend.ts): the same
 *  project+window scan, plus the llm-value fields. */
const OVERVIEW = `
  select ${LLM_VALUE_FIELDS},
         count(*)::int,
         count(*) filter (where not ok)::int,
         ${TOTAL_SPEND},
         ${KORTIX_SPEND},
         ${PROVIDER_SPEND},
         coalesce(sum(input_tokens), 0),
         coalesce(sum(output_tokens), 0)
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= now() - make_interval(days => 30)
`;

/** GET /v1/projects/:id/gateway/breakdown (projectSpendByModel,
 *  session-model-usage.ts): llm-value fields + the served-model group key,
 *  which reads the promoted served_model column and falls back to
 *  requested_model/resolved_model when the column is NULL (a row that never
 *  carried the key) — production's servedModelSql, verbatim. Grouped by
 *  the expressions, as production's `.groupBy(servedModelSql, logs.provider)`
 *  renders. */
const BREAKDOWN = `
  select ${LLM_VALUE_FIELDS},
         coalesce(
           served_model,
           case when provider = 'kortix' then resolved_model else requested_model end
         ) as model,
         provider,
         count(*)::int,
         count(*) filter (where not ok)::int,
         ${TOTAL_SPEND},
         ${KORTIX_SPEND},
         ${PROVIDER_SPEND},
         coalesce(sum(input_tokens + output_tokens), 0)
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= now() - make_interval(days => 30)
   group by coalesce(served_model,
              case when provider = 'kortix' then resolved_model else requested_model end),
            provider
   order by count(*) desc
   limit 12
`;

/** GET /v1/projects/:id/gateway/sessions (listProjectGatewaySessionSpend,
 *  session-costs.ts): per-session rollup of the same scan, with production's
 *  CostScope predicate (the OR arm reads session_id through the project's
 *  sessions) — account_id and session_id must be carried, or this query can
 *  never go index-only. */
const SESSIONS = `
  select session_id,
         count(*)::int,
         count(*) filter (where not ok)::int,
         ${LLM_VALUE_FIELDS},
         ${TOTAL_SPEND},
         coalesce(sum(input_tokens + output_tokens), 0)::float8,
         count(distinct requested_model)::int,
         max(created_at)
    from kortix.gateway_request_logs
   where project_id = $1
     and (account_id = $2 or session_id in (
            select s.session_id from kortix.project_sessions s where s.project_id = $1))
     and session_id is not null
     and created_at >= now() - make_interval(days => 30)
   group by 1
`;

/** GET /v1/projects/:id/gateway/sources (listProjectGatewaySourceSpend,
 *  session-costs.ts): the same scan plus the session attribution join, a
 *  distinct-session count and the CostScope OR arm — the columns that kept it
 *  heap-bound before v3. The llm-value fields read the promoted column
 *  (post-KRTX-4023 production), rendered with the log table's `l` alias. */
const SOURCES_LLM_FIELDS = `
         sum(${llmValueCase('l.')})::float8 as estimated_usage_value,
         count(${llmValueCase('l.')})::int as priced_requests,
         count(*) filter (where l.ok and ${llmValueCase('l.')} is null)::int as unpriced_requests`;
const SOURCES = `
  select coalesce(
           case when ps.initiator_type::text = 'trigger' then ps.initiator_id end,
           case when parent.initiator_type::text = 'trigger' then parent.initiator_id end,
           ps.initiator_type::text,
           case when l.session_id is null then 'unattributed' end,
           'unknown'
         ) as source,
         count(distinct l.session_id)::int,
         count(*)::int,
         count(*) filter (where not l.ok)::int,
         coalesce(sum(
           l.final_cost_precise + case when coalesce(
             l.billing_mode,
             case when l.final_cost_precise > 0 then 'credits' else 'none' end
           ) = 'credits' then 0 else l.upstream_cost_precise end
         ), 0)::float8,
         ${SOURCES_LLM_FIELDS}
    from kortix.gateway_request_logs l
    left join kortix.project_sessions ps
           on ps.session_id = l.session_id and ps.project_id = l.project_id
    left join kortix.project_sessions parent
           on parent.session_id = ps.parent_session_id
   where l.project_id = $1
     and (l.account_id = $2 or l.session_id in (
            select s.session_id from kortix.project_sessions s where s.project_id = $1))
     and l.created_at >= now() - make_interval(hours => 24)
   group by 1
`;

/** The gateway series shape: same scan, llm-value fields, tokens + errors +
 *  the three latency percentiles. */
const SERIES = `
  select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day,
         ${LLM_VALUE_FIELDS},
         count(*)::int,
         count(*) filter (where not ok)::int,
         ${TOTAL_SPEND},
         ${KORTIX_SPEND},
         ${PROVIDER_SPEND},
         coalesce(sum(input_tokens), 0),
         coalesce(sum(output_tokens), 0),
         coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int,
         coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int,
         coalesce(percentile_cont(0.99) within group (order by latency_ms), 0)::int
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= now() - make_interval(days => 30)
   group by 1
`;

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const INDEX = 'idx_gateway_logs_project_time_covering_v4';

/** The v4 definition the migration builds (20261108090000300), verbatim — the
 *  rebuild steps below recreate the index from it, so the suite always asserts
 *  against the migration's own SQL. */
const V4_DEFINITION = `
      create index if not exists ${INDEX}
        on kortix.gateway_request_logs (project_id, created_at) include (
          account_id, session_id, ok, provider, requested_model, resolved_model,
          served_model, usage_estimated, billing_mode, final_cost_precise,
          upstream_cost_precise, input_tokens, output_tokens, cached_tokens,
          cache_write_tokens, latency_ms, actor_user_id
        )`;

/** The projectAgg statement of GET /:projectId/gateway/budgets (gateway-spend.ts),
 *  with the same money expression llm-spend.ts composes. */
const BUDGETS_PROJECT_AGG = `
  select count(*)::int,
         coalesce(sum(
           final_cost_precise + case when coalesce(
             billing_mode,
             case when final_cost_precise > 0 then 'credits' else 'none' end
           ) = 'credits' then 0 else upstream_cost_precise end
         ), 0)::float8
    from kortix.gateway_request_logs
   where project_id = $1 and created_at >= date_trunc('month', now())
`;

suite('gateway_request_logs project aggregates are index-only', () => {
  let client: pg.Client;
  let superuser: pg.Client;
  const projectId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  // The backfill test's own project (suite-level so afterAll can clean it up).
  const edgeAccountId = crypto.randomUUID();
  const edgeProjectId = crypto.randomUUID();

  const planOf = async (sql: string, params: unknown[] = [projectId]): Promise<string> => {
    const { rows } = await client.query<{ plan: unknown[] }>(`explain (costs off) ${sql}`, params);
    return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
  };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    superuser = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL });
    await client.connect();
    await superuser.connect();
    await client.query(
      'insert into kortix.accounts (account_id, name) values ($1, $2) on conflict do nothing',
      [accountId, accountId],
    );
    await client.query(
      `insert into kortix.projects (project_id, account_id, name, repo_url) values ($1, $2, 'covering-index-test', 'https://example.test/covering.git')
       on conflict (project_id) do nothing`,
      [projectId, accountId],
    );
    // 4k month-to-date rows with a ~1.3 KB incompressible request payload and
    // a wide metadata jsonb, so the heap is wider than the index (v4 carries
    // no metadata — that width is what the promotion buys off the index). The
    // seed's metadata carries the promoted keys exactly as the writer emits
    // them, so the fill trigger (20261108090000100) populates the columns the
    // way prod rows look. Size is not what the plans below rest on
    // (`enable_seqscan = off` is): 40k rows of 2 KB timed the setup out at
    // 30 s on a loaded CI runner.
    await client.query(
      `insert into kortix.gateway_request_logs
         (account_id, project_id, request_id, session_id, provider, resolved_model, requested_model,
          status, billing_mode, ok, latency_ms, input_tokens, output_tokens, cached_tokens,
          cache_write_tokens, final_cost_precise, upstream_cost_precise, metadata, request, created_at)
       select $1, $2,
              'req-' || i,
              case when i % 3 = 0 then null else gen_random_uuid()::text end,
              'kortix', 'gpt-5', 'gpt-5',
              200,
              case when i % 4 = 0 then null else 'credits' end,
              i % 17 > 0, (i % 900)::int, (i % 500)::int, (i % 900)::int,
              (i % 300)::int, (i % 100)::int,
              ((i % 50) * 0.001)::numeric, ((i % 80) * 0.001)::numeric,
              jsonb_build_object(
                'servedModel', 'gpt-5',
                'usageEstimated', case when i % 5 = 0 then 'true' else 'false' end,
                'messages', (select string_agg(md5(i::text || g::text), '') from generate_series(1, 40) g)
              ),
              jsonb_build_object('messages', repeat('x', 200)),
              date_trunc('month', now()) + ((i % 400) || ' minutes')::interval
         from generate_series(1, 4000) as i`,
      [accountId, projectId],
    );
    await superuser.query('vacuum analyze kortix.gateway_request_logs');
    // Isolate the plan assertions on THIS index (KRTX-4023's invariant: every
    // column these aggregates read must be carried, so the planner CAN serve
    // them index-only). The sibling covering indexes would otherwise win the
    // cost race on a small single-project sandbox -- idx_gateway_logs_
    // account_time_covering carries the money/token columns and served the
    // money-only aggregates index-only before this migration too. Which index
    // the planner picks among real competitors is scale-dependent behavior the
    // KRTX-1769 precedent forbids pinning; eligibility is the structural
    // claim. The suite runs on its own database clone, so dropping the
    // siblings here touches nothing else; they need no restore.
    for (const sibling of [
      'idx_gateway_logs_account_ok',
      'idx_gateway_logs_account_time',
      'idx_gateway_logs_account_time_covering',
      'idx_gateway_logs_model',
      'idx_gateway_logs_project_failed_time',
      'idx_gateway_logs_project_session_time',
      'idx_gateway_logs_project_time',
      'idx_gateway_logs_session',
    ]) {
      await superuser.query(`drop index if exists kortix.${sibling}`);
    }
    // The Index-Only-Scan choice is scale-dependent planner behavior (the
    // KRTX-1769 precedent asserts presence instead for exactly this reason).
    // This test needs the structural claim, not the cost race: with seq scans
    // disabled and the sibling indexes gone, the only index path left is the
    // covering one, so the planner must produce an index-only plan over it if
    // -- and only if -- every column the aggregate reads lives in it. Without
    // the INCLUDE columns the same statement plans as a heap-fetching Index
    // Scan, so the assertion still discriminates.
    await client.query('set enable_seqscan = off');
  });

  afterAll(async () => {
    if (!client) return;
    await client
      .query('delete from kortix.gateway_request_logs where project_id = $1', [projectId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.projects where project_id = $1', [projectId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.accounts where account_id = $1', [accountId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.gateway_request_logs where account_id = $1', [edgeAccountId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.projects where project_id = $1', [edgeProjectId])
      .catch(() => undefined);
    await client
      .query('delete from kortix.accounts where account_id = $1', [edgeAccountId])
      .catch(() => undefined);
    await client.end();
    await superuser.end();
  });

  test('the budgets project aggregate plans as an index-only scan (no heap fetch)', async () => {
    const plan = await planOf(BUDGETS_PROJECT_AGG);
    // The account covering index also serves this aggregate's columns, so
    // WHICH covering index wins is a planner cost race (see the file
    // docstring); a heap fetch is the regression this asserts against.
    expect(plan).toContain('Index Only Scan');
    expect(plan).not.toContain('Heap Scan');
  });

  test('the gateway series plans as an index-only scan too (needs latency_ms carried)', async () => {
    const plan = await planOf(SERIES);
    expect(plan).toContain(`Index Only Scan using ${INDEX}`);
  });

  test('the gateway overview plans as an index-only scan (needs the llm-value columns carried — KRTX-4023)', async () => {
    const plan = await planOf(OVERVIEW);
    expect(plan).toContain(`Index Only Scan using ${INDEX}`);
  });

  test('the gateway breakdown plans as an index-only scan (needs the served-model and requested-model columns carried — KRTX-4023)', async () => {
    const plan = await planOf(BREAKDOWN);
    expect(plan).toContain(`Index Only Scan using ${INDEX}`);
  });

  test('the gateway sources aggregate plans index-only over the join too (KRTX-4449: session_id + account_id carried)', async () => {
    const plan = await planOf(SOURCES, [projectId, accountId]);
    expect(plan).toContain(`Index Only Scan using ${INDEX}`);
  });

  test('the index carries exactly the columns the aggregates read', async () => {
    const { rows } = await superuser.query<{ indexdef: string; indisvalid: boolean }>(
      `select pg_get_indexdef(c.oid) as indexdef, i.indisvalid
         from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = $1 and c.relkind = 'i'`,
      [INDEX],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ indisvalid: true });
    const def = rows[0].indexdef;
    expect(def).toContain('ON kortix.gateway_request_logs USING btree (project_id, created_at)');
    for (const column of [
      // KRTX-4449: read by the sources aggregate's attribution join, its
      // distinct-session count and its CostScope predicate.
      'session_id',
      'account_id',
      'ok',
      'provider',
      // The breakdown's group key and its fallback arm.
      'requested_model',
      'resolved_model',
      'served_model',
      'usage_estimated',
      'billing_mode',
      'final_cost_precise',
      'upstream_cost_precise',
      'input_tokens',
      'output_tokens',
      'cached_tokens',
      'cache_write_tokens',
      // The series shape's latency percentiles.
      'latency_ms',
      'actor_user_id',
    ]) {
      expect(def).toContain(column);
    }
    // The promotion's whole point: the wide metadata jsonb (bounded to 2000
    // bytes per row by the writer) is OUT of the index — the promoted columns
    // replace the only two keys the aggregates ever read from it.
    expect(def).not.toContain('metadata');
  });

  test('the sessions rollup also plans index-only over its own session covering index (KRTX-4023)', async () => {
    // Production serves the sessions rollup from
    // idx_gateway_logs_project_session_time (20261108090000400, partial on
    // session_id). The suite dropped it as a sibling; rebuild it from the
    // migration's own statement (plain -- a 4k-row test table), drop the
    // project covering index so it cannot win the cost race, and assert the
    // rollup plans index-only over the session index. Then restore the
    // beforeAll state (project index back, session index gone) so the vacuity
    // test below still sees exactly one index path.
    await superuser.query(`set lock_timeout = '30s'`);
    await superuser.query(`set statement_timeout = '5min'`);
    await superuser.query(`
      create index if not exists idx_gateway_logs_project_session_time
        on kortix.gateway_request_logs (project_id, session_id, created_at) include (
          account_id, ok, provider, resolved_model, requested_model,
          usage_estimated, billing_mode, final_cost_precise, upstream_cost_precise,
          input_tokens, output_tokens, cached_tokens, cache_write_tokens
        ) where session_id is not null`);
    await superuser.query(`drop index if exists kortix.${INDEX}`);
    const plan = await planOf(SESSIONS, [projectId, accountId]);
    expect(plan).toContain('Index Only Scan');
    expect(plan).toContain('idx_gateway_logs_project_session_time');
    await superuser.query(V4_DEFINITION);
    await superuser.query('drop index if exists kortix.idx_gateway_logs_project_session_time');
  });

  test('dropping the index flips the plan back to the heap path (the test is not vacuous)', async () => {
    await superuser.query(`drop index if exists kortix.${INDEX}`);
    // The four single-table shapes must leave the covering-index world
    // entirely: no index-only node anywhere in the plan (they touch no other
    // table with a usable index-only path).
    for (const shape of [BUDGETS_PROJECT_AGG, SERIES, OVERVIEW, BREAKDOWN]) {
      const plan = await planOf(shape);
      expect(plan).not.toContain(INDEX);
      expect(plan).not.toContain('Index Only Scan');
    }
    // The join shapes keep a nested index-only plan over project_sessions
    // (the CostScope subquery and the attribution join have their own
    // indexes); the invariant is the wide log table itself: it must heap-scan
    // once the covering index is gone.
    const sourcesPlan = await planOf(SOURCES, [projectId, accountId]);
    expect(sourcesPlan).not.toContain(INDEX);
    expect(sourcesPlan).toContain('Seq Scan on gateway_request_logs');
    const sessionsPlan = await planOf(SESSIONS, [projectId, accountId]);
    expect(sessionsPlan).not.toContain(INDEX);
    expect(sessionsPlan).toContain('Seq Scan on gateway_request_logs');
    // Rebuild with the migration's own statement (plain, not CONCURRENTLY --
    // this is a 4k-row test table), so the test also proves the migration's
    // SQL is what creates the index the other tests assert on.
    await superuser.query(`set lock_timeout = '30s'`);
    await superuser.query(`set statement_timeout = '5min'`);
    await superuser.query(V4_DEFINITION);
    for (const shape of [BUDGETS_PROJECT_AGG, SERIES, OVERVIEW, BREAKDOWN]) {
      const plan = await planOf(shape);
      expect(plan).toContain(`Index Only Scan using ${INDEX}`);
    }
    const rebuiltSourcesPlan = await planOf(SOURCES, [projectId, accountId]);
    expect(rebuiltSourcesPlan).toContain(`Index Only Scan using ${INDEX}`);
    const rebuiltSessionsPlan = await planOf(SESSIONS, [projectId, accountId]);
    expect(rebuiltSessionsPlan).toContain(`Index Only Scan using ${INDEX}`);
  });

  test('the backfill fills the promoted columns from metadata without changing what the aggregates read (KRTX-4023)', async () => {
    // Edge rows covering every jsonb shape the keys ever had: the real writer
    // emits JSON booleans, the seed above wrote the strings 'true'/'false',
    // and a JSON null must stay NULL (the readers treat it as a missing key).
    // Two openai gpt-6.1-sol rows make the llm-value equivalence below
    // actually price something. The fill trigger is disabled for the seed so
    // these rows reach the backfill as HISTORY rows — the pre-promotion state
    // the backfill exists to heal (with the trigger live, inserts fill
    // themselves and the backfill would find nothing to prove).
    await superuser.query(
      'alter table kortix.gateway_request_logs disable trigger fill_promoted_columns',
    );
    try {
      await client.query(
        'insert into kortix.accounts (account_id, name) values ($1, $2)',
        [edgeAccountId, edgeAccountId],
      );
      await client.query(
        `insert into kortix.projects (project_id, account_id, name, repo_url)
         values ($1, $2, 'backfill-edge', 'https://example.test/backfill.git')`,
        [edgeProjectId, edgeAccountId],
      );
      await client.query(
        `insert into kortix.gateway_request_logs
           (account_id, project_id, request_id, provider, resolved_model, requested_model,
            status, ok, latency_ms, input_tokens, output_tokens, cached_tokens,
            cache_write_tokens, final_cost_precise, upstream_cost_precise, metadata, created_at)
         values
           ($1, $2, 'bf-bool-true', 'kortix', 'served-a', 'req-a', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object('servedModel', 'served-a', 'usageEstimated', true), now()),
           ($1, $2, 'bf-bool-false', 'kortix', 'served-a', 'req-a', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object('servedModel', 'served-a', 'usageEstimated', false), now()),
           ($1, $2, 'bf-absent', 'kortix', 'served-a', 'req-a', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object(), now()),
           ($1, $2, 'bf-null-keys', 'kortix', 'served-a', 'req-a', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object('servedModel', null, 'usageEstimated', null), now()),
           ($1, $2, 'bf-string', 'kortix', 'served-b', 'req-b', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object('servedModel', 'served-b', 'usageEstimated', 'true'), now()),
           ($1, $2, 'bf-sol-estimated', 'openai', 'gpt-6.1-sol', 'codex/gpt-6.1-sol', 200, true, 10, 1000, 500, 100, 0, 0.001, 0,
            jsonb_build_object('servedModel', 'codex/gpt-6.1-sol', 'usageEstimated', true), now()),
           ($1, $2, 'bf-sol-reported', 'openai', 'gpt-6.1-sol', 'codex/gpt-6.1-sol', 200, true, 10, 2000, 500, 100, 0, 0.002, 0,
            jsonb_build_object('servedModel', 'codex/gpt-6.1-sol'), now()),
           -- G9 item 1: an oversized historical servedModel (old writers bounded
           -- nothing) is bounded by the backfill through clip_text_bytes, not
           -- copied verbatim into the tuple member.
           ($1, $2, 'bf-huge-served', 'kortix', 'served-c', 'req-c', 200, true, 10, 0, 0, 0, 0, 0, 0,
            jsonb_build_object('servedModel', repeat('🚀', 300), 'usageEstimated', false), now())
      `,
        [edgeAccountId, edgeProjectId],
      );
    } finally {
      await superuser.query(
        'alter table kortix.gateway_request_logs enable trigger fill_promoted_columns',
      );
    }

    // The backfill's promoted-columns pass (20261108090000200), verbatim in
    // the same idempotent batch loop: every pass shrinks its own selection,
    // so it ends when a batch changes nothing.
    for (;;) {
      const { rowCount } = await client.query(`
        update kortix.gateway_request_logs
           set served_model = kortix.clip_text_bytes(metadata->>'servedModel', 255),
               usage_estimated = (metadata->>'usageEstimated') = 'true'
         where log_id in (
           select log_id
             from kortix.gateway_request_logs
            where (served_model is null and metadata ? 'servedModel'
                   and metadata->>'servedModel' is not null)
               or (usage_estimated is null and metadata ? 'usageEstimated'
                   and metadata->>'usageEstimated' is not null)
            limit 5000
         )
      `);
      if (!rowCount) break;
    }

    const { rows: edge } = await client.query<{
      request_id: string;
      served_model: string | null;
      usage_estimated: boolean | null;
    }>(
      `select request_id, served_model, usage_estimated
         from kortix.gateway_request_logs
        where project_id = $1 order by request_id`,
      [edgeProjectId],
    );
    expect(Object.fromEntries(edge.map((r) => [r.request_id, [r.served_model, r.usage_estimated]])))
      .toEqual({
        // JSON booleans: the writer's shape.
        'bf-bool-true': ['served-a', true],
        'bf-bool-false': ['served-a', false],
        // Absent keys and JSON nulls: NULL, the pre-promotion shape the
        // readers treat as a missing key.
        'bf-absent': [null, null],
        'bf-null-keys': [null, null],
        // The seed's legacy string shape reads as the flag it renders.
        'bf-string': ['served-b', true],
        'bf-sol-estimated': ['codex/gpt-6.1-sol', true],
        // No usageEstimated key: the column stays NULL (never a guessed false).
        'bf-sol-reported': ['codex/gpt-6.1-sol', null],
        // The oversized historical key is bounded, never copied verbatim.
        'bf-huge-served': ['🚀'.repeat(63), false],
      });

    // The backfill's whole contract, on both projects' rows: the promoted
    // readers (columns) must read exactly what the metadata readers read.
    // First the served-model group key, then the llm-value case verbatim (the
    // metadata variant is the same case with only the flag predicate
    // swapped back to its pre-promotion form).
    for (const pid of [projectId, edgeProjectId]) {
      const { rows: key } = await client.query<{ via_column: string; via_metadata: string }>(
        `select distinct
                coalesce(served_model, case when provider = 'kortix' then resolved_model else requested_model end) as via_column,
                coalesce(metadata->>'servedModel', case when provider = 'kortix' then resolved_model else requested_model end) as via_metadata
           from kortix.gateway_request_logs
          where project_id = $1
            -- the deliberately-truncated oversized row reads the bounded
            -- prefix from the column, not the verbatim metadata key
            and octet_length(metadata->>'servedModel') <= 255`,
        [pid],
      );
      expect(key.every((r) => r.via_column === r.via_metadata)).toBe(true);

      const metadataCase = LLM_VALUE_CASE.replace(
        'not coalesce(usage_estimated, false)',
        `coalesce(metadata->>'usageEstimated', 'false') <> 'true'`,
      );
      const { rows: value } = await client.query<{ via_column: string; via_metadata: string }>(
        `select coalesce(sum(${LLM_VALUE_CASE}), 0)::text as via_column,
                coalesce(sum(${metadataCase}), 0)::text as via_metadata
           from kortix.gateway_request_logs where project_id = $1`,
        [pid],
      );
      expect(value[0]?.via_column).toBe(value[0]?.via_metadata);
    }
  });

  // G9 item 1: a historical row the OLD writer produced can carry an
  // oversized model string (nothing bounded it before the promotion); one
  // such row over the btree tuple limit fails the CONCURRENTLY build with
  // 54000 and leaves an INVALID index. The backfill must bound history
  // first — then the build succeeds.
  test('the backfill bounds oversized history and the v4 build then succeeds (G9 item 1)', async () => {
    await superuser.query(`drop index if exists kortix.${INDEX}`);
    await superuser.query(
      'alter table kortix.gateway_request_logs disable trigger fill_promoted_columns',
    );
    try {
      await client.query(
        `insert into kortix.gateway_request_logs
           (account_id, project_id, request_id, requested_model, resolved_model, provider,
            status, ok, billing_mode, final_cost_precise, upstream_cost_precise, metadata, created_at)
         values ($1, $2, 'bf-oversized', repeat('M', 3000), repeat('🚀', 400), 'openai',
                 200, true, 'none', 0, 0,
                 jsonb_build_object('servedModel', repeat('🚀', 300)), now())`,
        [edgeAccountId, edgeProjectId],
      );
    } finally {
      await superuser.query(
        'alter table kortix.gateway_request_logs enable trigger fill_promoted_columns',
      );
    }
    // The migration's own statements (20261108090000200): the truncation
    // passes, then the promoted-columns pass — verbatim, in order.
    for (;;) {
      const { rowCount } = await client.query(`
        update kortix.gateway_request_logs
           set requested_model = kortix.clip_text_bytes(requested_model, 255),
               resolved_model  = kortix.clip_text_bytes(resolved_model, 255)
         where log_id in (
           select log_id from kortix.gateway_request_logs
            where octet_length(requested_model) > 255 or octet_length(resolved_model) > 255
            limit 5000
         )
      `);
      if (!rowCount) break;
    }
    for (;;) {
      const { rowCount } = await client.query(`
        update kortix.gateway_request_logs
           set served_model = kortix.clip_text_bytes(metadata->>'servedModel', 255),
               usage_estimated = (metadata->>'usageEstimated') = 'true'
         where log_id in (
           select log_id from kortix.gateway_request_logs
            where (served_model is null and metadata ? 'servedModel'
                   and metadata->>'servedModel' is not null)
               or (usage_estimated is null and metadata ? 'usageEstimated'
                   and metadata->>'usageEstimated' is not null)
            limit 5000
         )
      `);
      if (!rowCount) break;
    }
    const { rows: bounded } = await client.query<{ requested_model: string; resolved_model: string; served_model: string | null }>(
      `select requested_model, resolved_model, served_model
         from kortix.gateway_request_logs where request_id = 'bf-oversized'`,
    );
    expect(bounded).toHaveLength(1);
    const oversized = bounded[0];
    expect(oversized).toBeTruthy();
    expect(Buffer.byteLength(oversized?.requested_model ?? '', 'utf8')).toBe(255);
    expect(Buffer.byteLength(oversized?.resolved_model ?? '', 'utf8')).toBe(252);
    expect(Buffer.byteLength(oversized?.served_model ?? '', 'utf8')).toBe(252);
    // G9 round 2: the helper's cut is the maximal byte-safe prefix — the
    // same prefix the writer's clipText produces for the same input (an
    // average-width cut would keep 97 of these 255 ASCII bytes).
    const { rows: helperCut } = await client.query<{ cut: string }>(
      `select kortix.clip_text_bytes($1 || '🚀'::text, 255) as cut`,
      ['X'.repeat(255)],
    );
    expect(helperCut[0]?.cut).toBe('X'.repeat(255));
    // The bounded history no longer overflows the tuple: the migration's own
    // build statement succeeds.
    await superuser.query(`set statement_timeout = '5min'`);
    await superuser.query(V4_DEFINITION);
    const { rows: valid } = await superuser.query<{ indisvalid: boolean }>(
      `select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid
        where c.relname = $1`,
      [INDEX],
    );
    expect(valid[0]).toMatchObject({ indisvalid: true });
  });

  // G9 item 2: the fill trigger is installed BEFORE the backfill runs, so an
  // old-writer insert that lands while the (potentially long) backfill is
  // running is healed at insert and the backfill's predicate skips it —
  // nothing between the two steps can leave a promoted column NULL forever.
  test('an insert that lands during the backfill is healed by the trigger and the backfill skips it (G9 item 2)', async () => {
    // The pre-trigger window: a row the trigger never saw (disabled insert).
    await superuser.query(
      'alter table kortix.gateway_request_logs disable trigger fill_promoted_columns',
    );
    try {
      await client.query(
        `insert into kortix.gateway_request_logs
           (account_id, project_id, request_id, requested_model, resolved_model, provider,
            status, ok, billing_mode, final_cost_precise, upstream_cost_precise, metadata, created_at)
         values ($1, $2, 'il-history', 'req-x', 'served-x', 'kortix', 200, true, 'none', 0, 0,
                 jsonb_build_object('servedModel', 'served-x', 'usageEstimated', true), now())`,
        [edgeAccountId, edgeProjectId],
      );
    } finally {
      await superuser.query(
        'alter table kortix.gateway_request_logs enable trigger fill_promoted_columns',
      );
    }
    // An insert that lands while the backfill is running: the trigger fills
    // it at insert.
    await client.query(
      `insert into kortix.gateway_request_logs
         (account_id, project_id, request_id, requested_model, resolved_model, provider,
          status, ok, billing_mode, final_cost_precise, upstream_cost_precise, metadata, created_at)
       values ($1, $2, 'il-during', 'req-y', 'served-y', 'kortix', 200, true, 'none', 0, 0,
               jsonb_build_object('servedModel', 'served-y', 'usageEstimated', true), now())`,
      [edgeAccountId, edgeProjectId],
    );
    const { rows: duringBefore } = await client.query<{ served_model: string | null }>(
      `select served_model from kortix.gateway_request_logs where request_id = 'il-during'`,
    );
    expect(duringBefore[0]?.served_model).toBe('served-y');

    // The backfill runs over both rows; its predicate only selects NULL
    // columns, so the trigger-filled row is untouched.
    for (;;) {
      const { rowCount } = await client.query(`
        update kortix.gateway_request_logs
           set served_model = kortix.clip_text_bytes(metadata->>'servedModel', 255),
               usage_estimated = (metadata->>'usageEstimated') = 'true'
         where log_id in (
           select log_id from kortix.gateway_request_logs
            where (served_model is null and metadata ? 'servedModel'
                   and metadata->>'servedModel' is not null)
               or (usage_estimated is null and metadata ? 'usageEstimated'
                   and metadata->>'usageEstimated' is not null)
            limit 5000
         )
      `);
      if (!rowCount) break;
    }

    const { rows: after } = await client.query<{ request_id: string; served_model: string | null; usage_estimated: boolean | null }>(
      `select request_id, served_model, usage_estimated
         from kortix.gateway_request_logs
        where request_id in ('il-history', 'il-during') order by request_id`,
    );
    expect(Object.fromEntries(after.map((r) => [r.request_id, [r.served_model, r.usage_estimated]]))).toEqual({
      // History: healed by the backfill.
      'il-history': ['served-x', true],
      // The during-backfill insert: healed by the trigger, unchanged by the
      // backfill.
      'il-during': ['served-y', true],
    });
  });

  // Review item 2026-11-08 (mixed widths): the helper's average-width seed
  // cut kept 97 bytes of a 255-ASCII-byte value — an historical/old-writer
  // identity truncated harder than the writer's clipText leaves the same
  // input. Each case pins the maximal byte-safe prefix: the widest
  // whole-code-point prefix within the byte budget (literal expectations,
  // not a reimplementation of the writer's greedy fill).
  test('clip_text_bytes keeps the maximal byte-safe code-point prefix (mixed widths)', async () => {
    const cases: Array<{ value: string | null; maxBytes: number; expected: string | null }> = [
      // The reproduced defect's input: 255 ASCII bytes then 300 rockets (the
      // whole string's 2.62 bytes/char average misled the old estimate to
      // 97 bytes). The writer keeps all 255 ASCII bytes.
      { value: `${'A'.repeat(255)}${'🚀'.repeat(300)}`, maxBytes: 255, expected: 'A'.repeat(255) },
      // Wide characters only: 63 rockets = 252 bytes; the 64th (256) exceeds.
      { value: '🚀'.repeat(300), maxBytes: 255, expected: '🚀'.repeat(63) },
      // 3-byte code points: 85 of them = 255 bytes exactly.
      { value: '中'.repeat(200), maxBytes: 255, expected: '中'.repeat(85) },
      // Narrow budget over mixed widths: a+b+c+复+读 = 9 bytes; the next
      // 复 adds 3 more and exceeds 10.
      { value: 'abc复读中', maxBytes: 10, expected: 'abc复读' },
      // Inside the budget the value is returned untouched.
      { value: 'gpt-6.1-sol', maxBytes: 255, expected: 'gpt-6.1-sol' },
      { value: '', maxBytes: 255, expected: '' },
      { value: null, maxBytes: 255, expected: null },
      { value: 'abc', maxBytes: 0, expected: '' },
    ];
    for (const c of cases) {
      const { rows } = await client.query<{ clipped: string | null }>(
        'select kortix.clip_text_bytes($1, $2) as clipped',
        [c.value, c.maxBytes],
      );
      expect(rows[0]?.clipped).toBe(c.expected);
      if (rows[0]?.clipped) {
        expect(Buffer.byteLength(rows[0].clipped, 'utf8')).toBe(
          Buffer.byteLength(c.expected ?? '', 'utf8'),
        );
      }
    }
  });

  // The same mixed-width key through the live fill trigger: the old writer's
  // shape (key in metadata only) must lift to exactly the string the writer
  // clipText produces for the same input — not an average-width estimate of
  // it.
  test('the fill trigger lifts a mixed-width served key exactly as wide as the writer clips it', async () => {
    await client.query(
      `insert into kortix.gateway_request_logs
         (account_id, project_id, request_id, requested_model, resolved_model, provider,
          status, ok, billing_mode, final_cost_precise, upstream_cost_precise, metadata, created_at)
       values ($1, $2, 'cx-mixed-width', 'req-mw', 'mw', 'kortix', 200, true, 'none', 0, 0,
               jsonb_build_object('servedModel', $3::text), now())`,
      [edgeAccountId, edgeProjectId, `${'A'.repeat(255)}${'🚀'.repeat(300)}`],
    );
    const { rows } = await client.query<{ served_model: string; bytes: number }>(
      `select served_model, octet_length(served_model) as bytes
         from kortix.gateway_request_logs where request_id = 'cx-mixed-width'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.served_model).toBe('A'.repeat(255));
    expect(rows[0]?.bytes).toBe(255);
  });
});
