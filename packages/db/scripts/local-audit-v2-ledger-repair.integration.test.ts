import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import pg from 'pg';
import { repairLocalAuditV2Ledger } from './local-audit-v2-ledger-repair';

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
const suite = adminUrl ? describe : describe.skip;
const migrationsDir = join(import.meta.dir, '..', 'migrations');
const databaseName = `kortix_local_audit_v2_${process.pid}_${Date.now()}`;
const databaseUrl = adminUrl ? new URL(adminUrl) : null;
if (databaseUrl) databaseUrl.pathname = `/${databaseName}`;

// The complete untracked audit-v2 signature, as real objects: the six
// signature queries must find exactly these names, or the planner refuses.
const auditColumns = [
  'agent_id', 'agent_name', 'authoritative_source', 'causation_id', 'client_reported_source',
  'delegation_depth', 'error_code', 'error_message', 'execution_id', 'initiator_actor_id',
  'initiator_actor_type', 'input_sha256', 'input_summary', 'integrity_hash',
  'integrity_previous_hash', 'message_id', 'runtime_session_id', 'output_sha256',
  'output_summary', 'parent_event_id', 'phase', 'session_sequence', 'source_ledger',
  'source_record_id', 'source_revision', 'tool_call_id', 'turn_id',
];
const tunnelColumns = ['actor_type', 'actor_user_id', 'phase', 'project_id', 'session_id'];
const functions = [
  'audit_connector_call', 'audit_enqueue_webhooks', 'audit_gateway_request',
  'audit_prepare_event', 'audit_project_session', 'audit_provider_event',
  'audit_reject_mutation', 'audit_session_lifecycle_command', 'audit_trigger_execution',
  'audit_tunnel_operation', 'audit_usage_event', 'audit_voice_turn',
];
const triggers = [
  'audit_events_append_only', 'audit_events_enqueue_webhooks', 'audit_events_prepare',
  'connector_calls_project_audit', 'gateway_request_logs_project_audit',
  'project_sessions_project_audit', 'project_trigger_executions_project_audit',
  'provider_events_project_audit', 'session_lifecycle_commands_project_audit',
  'tunnel_audit_logs_project_audit', 'usage_events_project_audit',
  'voice_call_turns_project_audit',
];

let admin: pg.Client;

suite('local audit-v2 ledger repair against a live server', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database "${databaseName}"`);

    const client = new pg.Client({ connectionString: databaseUrl?.toString() });
    await client.connect();
    try {
      await client.query(`
        create schema kortix;
        create schema kortix_migrations;
        create table kortix_migrations.pgmigrations (
          id serial primary key,
          name varchar(255) not null,
          run_on timestamp not null
        );
        insert into kortix_migrations.pgmigrations (name, run_on)
          values ('20260807221200000_centralized_audit_v2', clock_timestamp());
        create table kortix.audit_events (${auditColumns.map((c) => `${c} text`).join(', ')});
        create table kortix.tunnel_audit_logs (${tunnelColumns.map((c) => `${c} text`).join(', ')});
        create table kortix.audit_session_sequences (id integer);
        create table kortix.audit_webhook_deliveries (id integer);
      `);
      for (const name of functions) {
        await client.query(
          `create function kortix.${name}() returns trigger language plpgsql as $$ begin return null; end $$`,
        );
      }
      for (const name of triggers) {
        await client.query(
          `create trigger ${name} before insert on kortix.audit_events
             for each row execute function kortix.audit_prepare_event()`,
        );
      }
      await client.query(`
        create index idx_audit_webhook_delivery_due on kortix.audit_webhook_deliveries (id);
        create index idx_audit_webhook_delivery_event on kortix.audit_webhook_deliveries (id);
      `);
    } finally {
      await client.end();
    }
  });

  afterAll(async () => {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
  });

  test('runs the signature reads against a live server without a bind error', async () => {
    // The six signature queries each bind their name list as ONE text[]
    // parameter. A flat bind list throws `08P01 bind message supplies N
    // parameters, but prepared statement "" requires 1` here, before the
    // planner ever runs. With the ledger row present the planner
    // short-circuits (applied → false), so the observable contract is: no
    // throw, and the ledger row untouched.
    const repaired = await repairLocalAuditV2Ledger(databaseUrl?.toString() ?? '', migrationsDir);
    expect(repaired).toBe(false);

    const client = new pg.Client({ connectionString: databaseUrl?.toString() });
    await client.connect();
    try {
      const ledger = await client.query<{ name: string }>(
        `select name from kortix_migrations.pgmigrations where name = $1`,
        ['20260807221200000_centralized_audit_v2'],
      );
      expect(ledger.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});
