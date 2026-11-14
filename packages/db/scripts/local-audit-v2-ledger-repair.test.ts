import { describe, expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { planLocalAuditV2LedgerRepair, readSignature } from './local-audit-v2-ledger-repair';

const complete = {
  tables: ['audit_session_sequences', 'audit_webhook_deliveries'],
  auditColumns: [
    'agent_id', 'agent_name', 'authoritative_source', 'causation_id', 'client_reported_source',
    'delegation_depth', 'error_code', 'error_message', 'execution_id', 'initiator_actor_id',
    'initiator_actor_type', 'input_sha256', 'input_summary', 'integrity_hash',
    'integrity_previous_hash', 'message_id', 'runtime_session_id', 'output_sha256',
    'output_summary', 'parent_event_id', 'phase', 'session_sequence', 'source_ledger',
    'source_record_id', 'source_revision', 'tool_call_id', 'turn_id',
  ],
  tunnelColumns: ['actor_type', 'actor_user_id', 'phase', 'project_id', 'session_id'],
  functions: [
    'audit_connector_call', 'audit_enqueue_webhooks', 'audit_gateway_request',
    'audit_prepare_event', 'audit_project_session', 'audit_provider_event',
    'audit_reject_mutation', 'audit_session_lifecycle_command', 'audit_trigger_execution',
    'audit_tunnel_operation', 'audit_usage_event', 'audit_voice_turn',
  ],
  triggers: [
    'audit_events_append_only', 'audit_events_enqueue_webhooks', 'audit_events_prepare',
    'connector_calls_project_audit', 'gateway_request_logs_project_audit',
    'project_sessions_project_audit', 'project_trigger_executions_project_audit',
    'provider_events_project_audit', 'session_lifecycle_commands_project_audit',
    'tunnel_audit_logs_project_audit', 'usage_events_project_audit',
    'voice_call_turns_project_audit',
  ],
  indexes: ['idx_audit_webhook_delivery_due', 'idx_audit_webhook_delivery_event'],
};

describe('local audit-v2 ledger repair plan', () => {
  test('records a complete untracked schema once', () => {
    expect(planLocalAuditV2LedgerRepair(false, complete)).toBe(true);
    expect(planLocalAuditV2LedgerRepair(true, complete)).toBe(false);
  });

  test('leaves an untouched pre-v2 schema pending', () => {
    expect(
      planLocalAuditV2LedgerRepair(false, {
        tables: [], auditColumns: [], tunnelColumns: [], functions: [], triggers: [], indexes: [],
      }),
    ).toBe(false);
  });

  test('fails closed for a partial untracked schema', () => {
    expect(() =>
      planLocalAuditV2LedgerRepair(false, { ...complete, triggers: complete.triggers.slice(1) }),
    ).toThrow('partial local schema');
  });
});

describe('readSignature', () => {
  /** Maps a recorded query back to its signature section by its catalog source. */
  function sectionOf(sql: string): keyof typeof complete {
    if (sql.includes("join pg_namespace n on n.oid = c.relnamespace")) return 'tables';
    if (sql.includes("table_name = 'audit_events'")) return 'auditColumns';
    if (sql.includes("table_name = 'tunnel_audit_logs'")) return 'tunnelColumns';
    if (sql.includes('from pg_proc')) return 'functions';
    if (sql.includes('from pg_trigger')) return 'triggers';
    if (sql.includes('from pg_indexes')) return 'indexes';
    throw new Error(`unrecognized signature query: ${sql}`);
  }

  test('binds every section name list as ONE text[] parameter, in section order', async () => {
    const client = new pg.Client();
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    spyOn(client, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      const index = calls.length;
      calls.push({ sql: String(sql), params });
      return { rows: [{ name: `v${index}` }], rowCount: 1 } as unknown as pg.QueryResult<{
        name: string;
      }>;
    });

    const signature = await readSignature(client);

    expect(signature).toEqual({
      tables: ['v0'],
      auditColumns: ['v1'],
      tunnelColumns: ['v2'],
      functions: ['v3'],
      triggers: ['v4'],
      indexes: ['v5'],
    });
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      // One placeholder: the catalog SQL takes a single text[] parameter.
      expect(call.sql).toContain('any($1::text[])');
      expect(call.sql.match(/\$\d/g)).toEqual(['$1']);
      // The wrapped shape pg receives: ONE bind value, the section's name
      // list. A flat list throws `08P01 bind message supplies 2 parameters,
      // but prepared statement "" requires 1` on a real server.
      expect(call.params).toHaveLength(1);
      expect(call.params?.[0]).toEqual(complete[sectionOf(call.sql)]);
    }
  });
});
