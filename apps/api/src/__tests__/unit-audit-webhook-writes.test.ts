/**
 * Characterization for the audit-webhook mutations' audit writes (KRTX-4573):
 * create, update and delete each write EXACTLY ONE audit_events row, with its
 * action name (`iam.audit.webhook.create|update|delete`), the webhook id and
 * the before/after shape. Pins the behavior before the refactor routes the
 * three hand-rolled `recordAuditEvent` blocks through the shared `auditIam`
 * helper.
 *
 * The DB, the test-delivery sender and the SSRF guard are replaced by stubs
 * (`http-helpers.test.ts` precedent); the router, the handler bodies and the
 * audit call are the code under test.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { Context } from 'hono';

/** Every `recordAuditEvent` the three mutations filed this test run. */
const auditEvents: Array<Record<string, unknown>> = [];
mock.module('../shared/audit', () => ({
  AUDIT_READ_FLUSH_BARRIER_MS: 0,
  flushAuditEvents: async () => {},
  recordAuditEvent: async (event: Record<string, unknown>) => {
    auditEvents.push(event);
  },
}));

const WEBHOOK_ID = crypto.randomUUID();
const ACCOUNT_ID = crypto.randomUUID();
const WEBHOOK_ROW = {
  webhookId: WEBHOOK_ID,
  accountId: ACCOUNT_ID,
  url: 'https://hooks.example.test/siem',
  secret: 'whsec_test',
  name: 'siem',
  actionPrefix: 'iam.',
  enabled: true,
  createdBy: '11111111-1111-1111-1111-111111111111',
  createdAt: new Date('2026-11-01T12:00:00.000Z'),
  updatedAt: new Date('2026-11-01T12:00:00.000Z'),
  lastDeliveredAt: null,
  lastErrorAt: null,
  lastError: null,
};

mock.module('../marketplace/catalog', () => ({
  assertAllowedSourceAddress: () => {},
}));

/** The test-delivery/secret plumbing does not run in this test. */
mock.module('../shared/audit-webhooks', () => ({
  deliverTestEvent: async (row: { name: string }) => ({ ok: true, webhook: row.name }),
  generateWebhookSecret: () => WEBHOOK_ROW.secret,
  replayAuditWebhookDelivery: async () => ({ replayed: true }),
  wakeAuditWebhookDelivery: () => {},
}));

const USER = crypto.randomUUID();

/** Auth/IAM stubs: the mutations' authorization is not the unit under test. */
mock.module('../iam', () => ({
  ACCOUNT_ACTIONS: { ACCOUNT_WRITE: 'account.write', AUDIT_READ: 'audit.read' },
  assertAuthorized: async () => {},
}));
mock.module('../iam/actor', () => ({
  actorOf: async (c: Context) => `${c.get('userId')}@actor`,
}));

const { auditRouter } = await import('../accounts/audit');

// A Drizzle-shaped fake db: every insert/update/select/delete the three
// handlers run returns the seeded webhook row. The handler's audit call is
// what the asserts pin.
const db = {
  insert: () => ({
    values: (_v: unknown) => ({ returning: async () => [WEBHOOK_ROW] }),
  }),
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [WEBHOOK_ROW],
        orderBy: async () => [WEBHOOK_ROW],
      }),
    }),
  }),
  update: () => ({
    set: (_u: unknown) => ({
      where: () => ({ returning: async () => [{ ...WEBHOOK_ROW, name: 'siem-renamed', enabled: false, actionPrefix: null }] }),
    }),
  }),
  delete: () => ({
    where: () => ({
      returning: async () => [{ name: WEBHOOK_ROW.name, url: WEBHOOK_ROW.url }],
    }),
  }),
};
mock.module('../shared/db', () => ({ db }));

/** Entitlement off; the mutations' own gates are not the unit under test. */
mock.module('../accounts/iam/http-helpers', () => ({
  requireEntitlement: async () => null,
}));

const app = new Hono();
app.use('*', async (c, next) => {
  c.set('userId' as never, USER as never);
  c.set('authType' as never, 'supabase' as never);
  await next();
});
app.route('/v1/accounts', auditRouter);

const create = () =>
  app.request(`/v1/accounts/${ACCOUNT_ID}/audit/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'siem', url: 'https://hooks.example.test/siem' }),
  });
const update = () =>
  app.request(`/v1/accounts/${ACCOUNT_ID}/audit/webhooks/${WEBHOOK_ROW.webhookId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'siem-renamed', enabled: false, action_prefix: null }),
  });
const remove = () =>
  app.request(`/v1/accounts/${ACCOUNT_ID}/audit/webhooks/${WEBHOOK_ROW.webhookId}`, {
    method: 'DELETE',
  });

describe('the audit-webhook mutations write exactly one audit row', () => {
  test('create writes iam.audit.webhook.create with the webhook id', async () => {
    auditEvents.length = 0;
    const res = await create();
    expect(res.status).toBe(201);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe('iam.audit.webhook.create');
    expect(auditEvents[0]!.resourceType).toBe('audit_webhook');
    expect(auditEvents[0]!.resourceId).toBe(WEBHOOK_ROW.webhookId);
    expect(auditEvents[0]!.after).toEqual({ name: 'siem', url: WEBHOOK_ROW.url, action_prefix: 'iam.' });
  });

  test('update writes iam.audit.webhook.update with before and after', async () => {
    auditEvents.length = 0;
    const res = await update();
    expect(res.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe('iam.audit.webhook.update');
    expect(auditEvents[0]!.resourceId).toBe(WEBHOOK_ROW.webhookId);
    expect(auditEvents[0]!.before).toEqual({ name: 'siem', enabled: true, action_prefix: 'iam.' });
    expect(auditEvents[0]!.after).toEqual({ name: 'siem-renamed', enabled: false, action_prefix: null });
  });

  test('delete writes iam.audit.webhook.delete with the url in before', async () => {
    auditEvents.length = 0;
    const res = await remove();
    expect(res.status).toBe(200);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe('iam.audit.webhook.delete');
    expect(auditEvents[0]!.resourceId).toBe(WEBHOOK_ROW.webhookId);
    expect(auditEvents[0]!.before).toEqual({ name: 'siem', url: WEBHOOK_ROW.url });
  });
});
