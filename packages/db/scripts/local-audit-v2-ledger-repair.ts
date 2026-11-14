import type pg from 'pg';
import { hasMigration, insertMigration, withLedgerLock } from './migration-ledger';
import { verifyMigrationChecksum } from './ledger-repair';

const MIGRATION_NAME = '20260807221200000_centralized_audit_v2';
const MIGRATION_FILE = `${MIGRATION_NAME}.sql`;
const MIGRATION_SHA256 = '769b863ef0b62c4693e232cf102757ce3c3ee904f0f44c9aea450901a56e07f9';

const AUDIT_EVENT_COLUMNS = [
  'agent_id',
  'agent_name',
  'authoritative_source',
  'causation_id',
  'client_reported_source',
  'delegation_depth',
  'error_code',
  'error_message',
  'execution_id',
  'initiator_actor_id',
  'initiator_actor_type',
  'input_sha256',
  'input_summary',
  'integrity_hash',
  'integrity_previous_hash',
  'message_id',
  'runtime_session_id',
  'output_sha256',
  'output_summary',
  'parent_event_id',
  'phase',
  'session_sequence',
  'source_ledger',
  'source_record_id',
  'source_revision',
  'tool_call_id',
  'turn_id',
] as const;
const TUNNEL_COLUMNS = ['actor_type', 'actor_user_id', 'phase', 'project_id', 'session_id'] as const;
const FUNCTIONS = [
  'audit_connector_call',
  'audit_enqueue_webhooks',
  'audit_gateway_request',
  'audit_prepare_event',
  'audit_project_session',
  'audit_provider_event',
  'audit_reject_mutation',
  'audit_session_lifecycle_command',
  'audit_trigger_execution',
  'audit_tunnel_operation',
  'audit_usage_event',
  'audit_voice_turn',
] as const;
const TRIGGERS = [
  'audit_events_append_only',
  'audit_events_enqueue_webhooks',
  'audit_events_prepare',
  'connector_calls_project_audit',
  'gateway_request_logs_project_audit',
  'project_sessions_project_audit',
  'project_trigger_executions_project_audit',
  'provider_events_project_audit',
  'session_lifecycle_commands_project_audit',
  'tunnel_audit_logs_project_audit',
  'usage_events_project_audit',
  'voice_call_turns_project_audit',
] as const;
const INDEXES = ['idx_audit_webhook_delivery_due', 'idx_audit_webhook_delivery_event'] as const;

interface AuditV2Signature {
  tables: string[];
  auditColumns: string[];
  tunnelColumns: string[];
  functions: string[];
  triggers: string[];
  indexes: string[];
}

function exact(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function planLocalAuditV2LedgerRepair(
  ledgerApplied: boolean,
  signature: AuditV2Signature,
): boolean {
  if (ledgerApplied) return false;
  const sections: Array<[string[], readonly string[]]> = [
    [signature.tables, ['audit_session_sequences', 'audit_webhook_deliveries']],
    [signature.auditColumns, AUDIT_EVENT_COLUMNS],
    [signature.tunnelColumns, TUNNEL_COLUMNS],
    [signature.functions, FUNCTIONS],
    [signature.triggers, TRIGGERS],
    [signature.indexes, INDEXES],
  ];
  const present = sections.reduce((count, [actual]) => count + actual.length, 0);
  if (present === 0) return false;
  if (!sections.every(([actual, expected]) => exact(actual, expected))) {
    throw new Error(
      `${MIGRATION_NAME} has a partial local schema without a migration ledger row; refusing to mark it applied.`,
    );
  }
  return true;
}

/**
 * The one catalog signature read: each section is a data row (its query and
 * its expected name list) run through the same query-then-`name`-map.
 *
 * `params` is the bind-value array pg receives: each row wraps its name list
 * as ONE text[] parameter, because the SQL takes a single `$1::text[]`. A
 * flat list throws `08P01 bind message supplies N parameters, but prepared
 * statement "" requires 1` (the base call sites wrapped each list the same
 * way). `local-audit-v2-ledger-repair.test.ts` pins the wrapped shape.
 */
const SIGNATURE_QUERIES: Array<{
  section: keyof AuditV2Signature;
  sql: string;
  params: string[][];
}> = [
  {
    section: 'tables',
    sql: `
      select relname as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'kortix'
         and c.relkind = 'r'
         and relname = any($1::text[])
       order by relname
    `,
    params: [['audit_session_sequences', 'audit_webhook_deliveries']],
  },
  {
    section: 'auditColumns',
    sql: `
      select column_name as name
        from information_schema.columns
       where table_schema = 'kortix'
         and table_name = 'audit_events'
         and column_name = any($1::text[])
       order by column_name
    `,
    params: [AUDIT_EVENT_COLUMNS],
  },
  {
    section: 'tunnelColumns',
    sql: `
      select column_name as name
        from information_schema.columns
       where table_schema = 'kortix'
         and table_name = 'tunnel_audit_logs'
         and column_name = any($1::text[])
       order by column_name
    `,
    params: [TUNNEL_COLUMNS],
  },
  {
    section: 'functions',
    sql: `
      select proname as name
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'kortix'
         and proname = any($1::text[])
       order by proname
    `,
    params: [FUNCTIONS],
  },
  {
    section: 'triggers',
    sql: `
      select tgname as name
        from pg_trigger
       where not tgisinternal
         and tgname = any($1::text[])
       order by tgname
    `,
    params: [TRIGGERS],
  },
  {
    section: 'indexes',
    sql: `
      select indexname as name
        from pg_indexes
       where schemaname = 'kortix'
         and indexname = any($1::text[])
       order by indexname
    `,
    params: [INDEXES],
  },
];

/** One query-then-map: the `name` column of every row, in query order. */
async function namesOf(client: pg.Client, sql: string, params: string[][]): Promise<string[]> {
  const result = await client.query<{ name: string }>(sql, params);
  return result.rows.map((row) => row.name);
}

export async function readSignature(client: pg.Client): Promise<AuditV2Signature> {
  // One read at a time, in SIGNATURE_QUERIES order: the client is a single
  // pg connection, and Promise.all over it is pg's "client is already
  // executing a query" deprecation (removed in pg@9).
  const signature: AuditV2Signature = {
    tables: [],
    auditColumns: [],
    tunnelColumns: [],
    functions: [],
    triggers: [],
    indexes: [],
  };
  for (const { section, sql, params } of SIGNATURE_QUERIES) {
    signature[section] = await namesOf(client, sql, params);
  }
  return signature;
}

export async function repairLocalAuditV2Ledger(
  databaseUrl: string,
  migrationsDir: string,
): Promise<boolean> {
  verifyMigrationChecksum(migrationsDir, { filename: MIGRATION_FILE, sha256: MIGRATION_SHA256 });

  return withLedgerLock(databaseUrl, false, async (client) => {
    const applied = await hasMigration(client, MIGRATION_NAME);
    const repair = planLocalAuditV2LedgerRepair(applied, await readSignature(client));
    if (!repair) {
      return false;
    }
    if ((await insertMigration(client, MIGRATION_NAME)) !== 1) {
      throw new Error(`Could not record ${MIGRATION_NAME} in the local migration ledger.`);
    }
    return true;
  });
}
