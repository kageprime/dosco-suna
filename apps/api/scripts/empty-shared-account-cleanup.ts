/**
 * Operator cleanup: delete the empty "Everyone in workspace" accounts that
 * connector sync seeded for every Composio and Pipedream connector. Their
 * provider holds the sign-in, so an empty shared row was never an account: it
 * showed "Sign-in not finished" beside the member's own account, and counted
 * as one in the connector header. Sync no longer seeds it
 * (`skipsEmptyProjectAccount`); a person who wants a shared account adds it.
 *
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/empty-shared-account-cleanup.ts            # dry run
 *   dotenvx run -f apps/api/.env.<env> -- bun run apps/api/scripts/empty-shared-account-cleanup.ts --apply    # delete
 *   ... --project <uuid>   one project
 *
 * A row is deleted only when ALL hold, checked again inside the DELETE:
 * project-owned, on a Composio or Pipedream connector, created by no person
 * (sync), no connected account, no stored credential, not pinned as default,
 * not touched for 1 day (no sign-in in flight), and nothing points at it
 * (session bindings, event triggers, account rules, OAuth apps, calls).
 * Idempotent: a re-run finds nothing. It reads no secret value.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/shared/db';

const args = process.argv.slice(2);
for (const [i, a] of args.entries()) {
  if (a === '--apply' || a === '--project' || args[i - 1] === '--project') continue;
  throw new Error(`unknown arg ${a}`);
}
const apply = args.includes('--apply');
const projectIndex = args.indexOf('--project');
const projectId = projectIndex >= 0 ? args[projectIndex + 1] : undefined;
if (projectIndex >= 0 && !/^[0-9a-f-]{36}$/i.test(projectId ?? '')) throw new Error('--project needs a project uuid');

const eligible = sql`
  cc.owner_type = 'project'
  and cc.created_by is null
  and cc.is_default = false
  and coalesce(cc.metadata->>'connected_account_id', '') = ''
  and cc.updated_at < now() - interval '1 day'
  and exists (select 1 from kortix.connectors c where c.connector_id = cc.connector_id and c.provider_type in ('composio', 'pipedream'))
  and not exists (select 1 from kortix.connection_credentials x where x.connection_id = cc.connection_id)
  and not exists (select 1 from kortix.project_session_connector_bindings x where x.connection_id = cc.connection_id)
  and not exists (select 1 from kortix.project_trigger_event_subscriptions x where x.connection_id = cc.connection_id)
  and not exists (select 1 from kortix.connection_policies x where x.connection_id = cc.connection_id)
  and not exists (select 1 from kortix.connection_oauth_applications x where x.connection_id = cc.connection_id)
  and not exists (select 1 from kortix.connector_calls x where x.connection_id = cc.connection_id)
  ${projectId ? sql`and cc.project_id = ${projectId}` : sql``}`;

const started = Date.now();
const counted = await db.execute<{ provider: string; rows: number; projects: number }>(sql`
  select c.provider_type as provider, count(*)::int as rows, count(distinct cc.project_id)::int as projects
  from kortix.connector_connections cc join kortix.connectors c using (connector_id)
  where ${eligible} group by 1 order by 1`);
let deleted = 0;
if (apply) {
  for (;;) {
    const batch = await db.execute<{ connection_id: string }>(sql`
      delete from kortix.connector_connections where connection_id in (
        select cc.connection_id from kortix.connector_connections cc where ${eligible} limit 500
      ) returning connection_id`);
    const rows = Array.from(batch as unknown as Array<{ connection_id: string }>);
    deleted += rows.length;
    if (rows.length < 500) break;
  }
}
process.stdout.write(`\n${apply ? 'APPLIED' : 'DRY RUN (no writes; pass --apply)'} in ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
for (const row of Array.from(counted as unknown as Array<{ provider: string; rows: number; projects: number }>)) {
  process.stdout.write(`  ${row.provider.padEnd(10)} ${apply ? 'eligible' : 'would delete'} ${row.rows} in ${row.projects} projects\n`);
}
if (apply) process.stdout.write(`  deleted ${deleted}\n`);
process.exit(0);
