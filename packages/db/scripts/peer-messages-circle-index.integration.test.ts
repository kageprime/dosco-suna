/**
 * The multi-agent circle lookups on `kortix.project_sessions` are index-served
 * (KRTX-4729).
 *
 * `peer-messages/service.ts` resolves a recipient and reads a session's
 * circle with two JSON-metadata predicates that no plain column index can
 * serve:
 *   `circleOf`:  `session_id IN (...) OR parent_session_id = ... OR
 *                metadata->>'team_lead' IN (...)` — the team_lead arm has no
 *                project predicate, so pre-index the planner answered the OR
 *                with a full table scan;
 *   `byHandle`:  `project_id = ... AND metadata->>'agent_handle' = ...`.
 * `team-tasks/service.ts` (handle-taken check, teammate list) runs the same
 * two shapes. One send by agent name carried 1.7-4.4 s of DB wall on prod
 * (2026-11-11: `server_timing` `db;dur=~1800;desc="n=~38"`), which read as a
 * 3.35x p95 rise on `POST .../peer-messages` at quiet hours.
 *
 * `20261111142149877_peer_msg_p95_circle_indexes.concurrent.ts` builds the two
 * partial expression indexes. This test reads the live catalog and the live
 * planner (`EXPLAIN FORMAT JSON`) over a seeded 40k-row table — never source
 * text. Without the migration both tests fail: the indexes are missing and
 * the planner seq-scans. Mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// A seeded table the planner will not seq-scan when an index arm covers every
// OR branch. 40k rows keeps the choice deterministic in both directions: too
// small and the planner picks a seq scan even with the indexes present.
const FILLER_ROWS = 40_000;
const SEED_ACCOUNT = '11111111-4729-4a29-9c60-000000000001';
const SEED_PROJECT = '22222222-4729-4a29-9c60-000000000002';

const EXPECTED_INDEXES = [
  'idx_project_sessions_project_agent_handle',
  'idx_project_sessions_team_lead',
];

suite('kortix.project_sessions circle lookups are index-served (KRTX-4729)', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  /** Every node of an EXPLAIN FORMAT JSON plan tree, flattened. */
  const planNodes = (plan: unknown): { nodeType: string; relation?: string; index?: string }[] => {
    const out: { nodeType: string; relation?: string; index?: string }[] = [];
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      const record = node as Record<string, unknown>;
      out.push({
        nodeType: typeof record['Node Type'] === 'string' ? (record['Node Type'] as string) : '',
        relation:
          typeof record['Relation Name'] === 'string'
            ? (record['Relation Name'] as string)
            : undefined,
        index:
          typeof record['Index Name'] === 'string' ? (record['Index Name'] as string) : undefined,
      });
      for (const value of Object.values(record)) visit(value);
    };
    visit(plan);
    return out;
  };

  beforeAll(async () => {
    await withClient(seed);
  }, 30_000);

  afterAll(async () => {
    // The db-suites lane migrates a fresh database per file, so the seed is
    // disposable there; the local worktree database is shared, so leave
    // nothing behind. The account FK cascades project and session rows.
    await withClient(async (client) => {
      await client.query('delete from kortix.accounts where account_id = $1', [SEED_ACCOUNT]);
    });
  }, 30_000);

  test('the two circle indexes exist and are valid', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ name: string; valid: boolean }>(
        `
        select i.relname as name, idx.indisvalid as valid
          from pg_index idx
          join pg_class i on i.oid = idx.indexrelid
          join pg_class t on t.oid = idx.indrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'kortix' and t.relname = 'project_sessions'
           and i.relname = any($1)
      `,
        [EXPECTED_INDEXES],
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...EXPECTED_INDEXES].sort());
      for (const row of rows) expect(row.valid).toBe(true);
    });
  });

  test('circleOf: no seq scan over project_sessions; the team_lead arm is index-served', async () => {
    await withClient(async (client) => {
      // The exact shape `circleOf` issues (peer-messages/service.ts): OR of
      // session ids, parent, and the team_lead JSON extraction, live-only.
      const { rows } = await client.query(`
        explain (format json)
        select * from kortix.project_sessions
         where coalesce(metadata ->> 'deletedAt', '') = ''
           and (session_id in ('s-1', 's-2')
                or parent_session_id = 's-3'
                or metadata ->> 'team_lead' in ('team-lead-aaa', 'team-lead-bbb'))
         order by updated_at desc
         limit 200
      `);
      const plan = queryPlanOf(rows);
      const nodes = planNodes(plan);
      expect(nodes.some((n) => n.relation === 'project_sessions')).toBe(true);
      expect(
        nodes.some((n) => n.relation === 'project_sessions' && n.nodeType === 'Seq Scan'),
      ).toBe(false);
      expect(nodes.some((n) => n.index === 'idx_project_sessions_team_lead')).toBe(true);
    });
  }, 30_000);

  test('byHandle: no seq scan over project_sessions; the agent_handle index is used', async () => {
    await withClient(async (client) => {
      // The exact shape `resolveRecipient`'s handle branch issues
      // (peer-messages/service.ts): project-scoped handle lookup, live-only.
      const { rows } = await client.query(
        `
        explain (format json)
        select * from kortix.project_sessions
         where project_id = $1
           and coalesce(metadata ->> 'deletedAt', '') = ''
           and metadata ->> 'agent_handle' = $2
         limit 6
      `,
        [SEED_PROJECT, 'worker-1'],
      );
      const plan = queryPlanOf(rows);
      const nodes = planNodes(plan);
      expect(nodes.some((n) => n.relation === 'project_sessions')).toBe(true);
      expect(
        nodes.some((n) => n.relation === 'project_sessions' && n.nodeType === 'Seq Scan'),
      ).toBe(false);
      expect(nodes.some((n) => n.index === 'idx_project_sessions_project_agent_handle')).toBe(true);
    });
  }, 30_000);
});

/** The plan document of an `explain (format json)` result; fails loudly when the query returned nothing. */
function queryPlanOf(rows: Record<string, unknown>[]): unknown {
  const first = rows[0];
  if (!first) throw new Error('EXPLAIN (FORMAT JSON) returned no row');
  return first['QUERY PLAN'];
}

/** Seed the filler rows and the handful the queries actually match, then ANALYZE. One transaction: a failed run leaves nothing. */
async function seed(client: pg.Client): Promise<void> {
  await client.query('begin');
  try {
    await client.query(
      `
      insert into kortix.accounts (account_id, name)
      values ($1, 'peer-p95-seed')
      on conflict do nothing
    `,
      [SEED_ACCOUNT],
    );
    await client.query(
      `
      insert into kortix.projects (project_id, account_id, name, repo_url)
      values ($1, $2, 'peer-p95-seed', 'https://example.invalid/peer-p95-seed')
      on conflict do nothing
    `,
      [SEED_PROJECT, SEED_ACCOUNT],
    );
    // Filler: the bulk of the table, no handle, no team_lead, live.
    await client.query(
      `
      insert into kortix.project_sessions (session_id, account_id, project_id, branch_name)
      select 'p95fill-' || g::text, $1, $2, 'p95fill-' || g::text
        from generate_series(1, $3::int) g
      on conflict do nothing
    `,
      [SEED_ACCOUNT, SEED_PROJECT, FILLER_ROWS],
    );
    // The rows the queries match: handles in the seed project, team members
    // behind two leads.
    await client.query(
      `
      insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, metadata)
      select 'p95handle-' || g::text, $1, $2, 'p95handle-' || g::text,
             jsonb_build_object('agent_handle', 'worker-' || g::text)
        from generate_series(1, 30) g
      on conflict do nothing
    `,
      [SEED_ACCOUNT, SEED_PROJECT],
    );
    await client.query(
      `
      insert into kortix.project_sessions (session_id, account_id, project_id, branch_name, parent_session_id, metadata)
      select 'p95team-' || g::text, $1, $2, 'p95team-' || g::text, 'p95fill-3',
             jsonb_build_object('team_lead', case when g % 2 = 0 then 'team-lead-aaa' else 'team-lead-bbb' end)
        from generate_series(1, 60) g
      on conflict do nothing
    `,
      [SEED_ACCOUNT, SEED_PROJECT],
    );
    // Fresh stats: a bulk insert into an otherwise quiet table otherwise leaves
    // the planner guessing, and the plan assertions depend on real estimates.
    await client.query('analyze kortix.project_sessions');
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}
