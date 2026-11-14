/**
 * Integration test (real local DB): a new subprocessor is announced to every
 * paid account 30 days before it takes effect (DPA section 7.3), once, and
 * leaves evidence: an audit event per account and a report to privacy@.
 * Captured: the email transport. Everything else is real: credit_accounts,
 * account members, auth users, audit_events and chat_event_dedup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { accountMembers, auditEvents, creditAccounts } from '@kortix/db';
import type { Subprocessor } from '@kortix/shared/subprocessors';
import { and, eq, sql } from 'drizzle-orm';
import { setOwnerAlertSenderForTest } from '../billing/services/owner-alerts';
import { openSubprocessorNotices, runSubprocessorNoticeSweep, workspaceScope } from '../billing/services/subprocessor-notices';
import { config } from '../config';
import type { EmailMessage } from '../lib/email/types';
import { db } from '../shared/db';
import { deleteFromView, insertIntoView } from './helpers/compat-views';
import { removeSeeded, seedProject, type SeededProject } from './helpers/integration-fixtures';

const OWNER = crypto.randomUUID();
const ADMIN = crypto.randomUUID();
const MEMBER = crypto.randomUUID();
const FREE_OWNER = crypto.randomUUID();
// A second paid account, with only an owner.
const SECOND_OWNER = crypto.randomUUID();
const email = (id: string, role: string) => `subproc-${role}-${id.slice(0, 8)}@example.test`;

const ROWS: Subprocessor[] = [
  { name: 'Established Hosting, Inc.', purpose: 'Hosting', location: 'United Kingdom' },
  { name: 'Example Inference, Inc.', purpose: 'Inference for Dosco-managed AI models', location: 'United States', addedOn: '2026-10-18' },
];

let paid: SeededProject;
let free: SeededProject;
let second: SeededProject;
// A paid account nobody can be emailed for yet.
let unreachable: SeededProject;
let sent: EmailMessage[] = [];
const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Dosco compliance]'));
const privacyReports = () => sent.filter((m) => m.subject.startsWith('[Dosco compliance]'));
const savedEnv = config.INTERNAL_KORTIX_ENV;

beforeAll(async () => {
  paid = await seedProject('subproc-paid');
  free = await seedProject('subproc-free');
  second = await seedProject('subproc-second');
  unreachable = await seedProject('subproc-unreachable');
  for (const [id, role] of [[OWNER, 'owner'], [ADMIN, 'admin'], [MEMBER, 'member'], [FREE_OWNER, 'free-owner'], [SECOND_OWNER, 'second-owner']] as const) {
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, role)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
  }
  await insertIntoView(db, accountMembers, { userId: OWNER, accountId: paid.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: ADMIN, accountId: paid.account_id, accountRole: 'admin' });
  await insertIntoView(db, accountMembers, { userId: MEMBER, accountId: paid.account_id, accountRole: 'member' });
  await insertIntoView(db, accountMembers, { userId: FREE_OWNER, accountId: free.account_id, accountRole: 'owner' });
  await insertIntoView(db, accountMembers, { userId: SECOND_OWNER, accountId: second.account_id, accountRole: 'owner' });
  await db.insert(creditAccounts).values([
    { accountId: paid.account_id, tier: 'credits' },
    { accountId: free.account_id, tier: 'free' },
    { accountId: second.account_id, tier: 'tier_2_20' },
    { accountId: unreachable.account_id, tier: 'credits' },
  ]);
  setOwnerAlertSenderForTest(async (message) => {
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
  config.INTERNAL_KORTIX_ENV = 'prod';
});

afterAll(async () => {
  setOwnerAlertSenderForTest(null);
  config.INTERNAL_KORTIX_ENV = savedEnv;
  if (!paid) return;
  for (const { account_id } of [paid, free, second, unreachable]) {
    await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account_id));
  }
  await db.execute(sql`delete from kortix.chat_event_dedup where event_id like 'legal:subprocessor-notice:%'`);
  await removeSeeded([paid, free, second, unreachable]);
  await db.execute(sql`delete from auth.users where id in (${OWNER}::uuid, ${ADMIN}::uuid, ${MEMBER}::uuid, ${FREE_OWNER}::uuid, ${SECOND_OWNER}::uuid)`);
});

describe('open subprocessor notices', () => {
  test('a notice is open from the day its row is added until the day before it takes effect, 37 days later', () => {
    expect(openSubprocessorNotices(ROWS, '2026-10-17')).toEqual([]);
    const [onDay] = openSubprocessorNotices(ROWS, '2026-10-18');
    expect(onDay).toEqual({ addedOn: '2026-10-18', effectiveDate: '2026-11-24', rows: [ROWS[1]!] });
    expect(openSubprocessorNotices(ROWS, '2026-11-23')).toHaveLength(1);
    expect(openSubprocessorNotices(ROWS, '2026-11-24')).toEqual([]);
  });
});

describe('the workspace scope of a recipient', () => {
  test('one workspace keeps the old copy, several are listed, and every paid account reads all workspaces', () => {
    expect(workspaceScope(['subproc-paid-account'], 4)).toBe('subproc-paid-account');
    expect(workspaceScope(['a-account', 'b-account', 'c-account'], 7)).toBe('a-account, b-account, and c-account');
    expect(workspaceScope(['a-account', 'b-account'], 2)).toBe('all workspaces');
    // Two memberships in workspaces that share a name list once.
    expect(workspaceScope(['a-account', 'a-account'], 3)).toBe('a-account');
  });
});

describe('the subprocessor notice sweep', () => {
  test('emails the owner and the admin of a paid account (not the member, not a free account), once, with evidence', async () => {
    const now = new Date('2026-10-20T09:00:00Z');
    expect(await runSubprocessorNoticeSweep(now, ROWS)).toEqual({ accountsNotified: 2 });

    const to = customerEmails().flatMap((message) => message.to).sort();
    expect(to).toEqual([email(ADMIN, 'admin'), email(OWNER, 'owner'), email(SECOND_OWNER, 'second-owner')].sort());
    const [message] = customerEmails().filter((m) => m.to[0] !== email(SECOND_OWNER, 'second-owner'));
    expect(message!.subject).toBe('Dosco subprocessor update, effective November 24, 2026');
    expect(message!.category).toBe('legal-subprocessor-notice');
    expect(message!.replyTo).toBe('privacy@dosco.live');
    expect(message!.text).toContain('Example Inference, Inc.: Inference for Dosco-managed AI models (United States)');
    expect(message!.text).toContain('/legal/subprocessors');
    expect(message!.text).not.toContain('Established Hosting');

    const [audit] = await db
      .select({ resourceId: auditEvents.resourceId, outputSummary: auditEvents.outputSummary })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, paid.account_id), eq(auditEvents.action, 'legal.subprocessor_notice.sent')));
    expect(audit!.resourceId).toBe('2026-10-18');
    expect(audit!.outputSummary).toMatchObject({ recipients: 2, effective_date: '2026-11-24', subprocessors: ['Example Inference, Inc.'] });
    const freeAudits = await db
      .select({ id: auditEvents.eventId })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, free.account_id), eq(auditEvents.action, 'legal.subprocessor_notice.sent')));
    expect(freeAudits).toEqual([]);

    const [report] = privacyReports();

    expect(report!.to).toEqual(['privacy@dosco.live']);
    expect(report!.subject).toBe('[Dosco compliance] Subprocessor notice sent to 2 accounts');

    expect(report!.text).toContain('takes effect November 24, 2026, 34 days from now');

    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T10:00:00Z'), ROWS)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('an account with nobody to email is retried by a later sweep, not dropped', async () => {
    const owner = crypto.randomUUID();
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${owner}::uuid, ${email(owner, 'late-owner')}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    await insertIntoView(db, accountMembers, { userId: owner, accountId: unreachable.account_id, accountRole: 'owner' });
    try {
      expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T11:00:00Z'), ROWS)).toEqual({ accountsNotified: 1 });
      expect(customerEmails().flatMap((message) => message.to)).toEqual([email(owner, 'late-owner')]);
    } finally {
      await deleteFromView(db, accountMembers, eq(accountMembers.userId, owner));
      await db.execute(sql`delete from auth.users where id = ${owner}::uuid`);
    }
  });

  test('a person who manages several paid accounts gets one email listing them, not one per project', async () => {
    const owner = crypto.randomUUID();
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${owner}::uuid, ${email(owner, 'batch-owner')}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    const batchA = await seedProject('subproc-batch-a');
    const batchB = await seedProject('subproc-batch-b');
    await insertIntoView(db, accountMembers, { userId: owner, accountId: batchA.account_id, accountRole: 'owner' });
    await insertIntoView(db, accountMembers, { userId: owner, accountId: batchB.account_id, accountRole: 'admin' });
    await db.insert(creditAccounts).values([
      { accountId: batchA.account_id, tier: 'credits' },
      { accountId: batchB.account_id, tier: 'tier_2_20' },
    ]);
    try {
      expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T12:00:00Z'), ROWS)).toEqual({ accountsNotified: 2 });

      const mine = customerEmails().filter((m) => m.to[0] === email(owner, 'batch-owner'));
      expect(mine).toHaveLength(1);
      expect(mine[0]!.text).toContain('subproc-batch-a-account and subproc-batch-b-account');
      expect(mine[0]!.subject).toBe('Dosco subprocessor update, effective November 24, 2026');

      for (const batched of [batchA, batchB]) {
        const [audit] = await db
          .select({ outputSummary: auditEvents.outputSummary })
          .from(auditEvents)
          .where(and(eq(auditEvents.accountId, batched.account_id), eq(auditEvents.action, 'legal.subprocessor_notice.sent')));
        expect(audit!.outputSummary).toMatchObject({ recipients: 1, effective_date: '2026-11-24', subprocessors: ['Example Inference, Inc.'] });
      }

      // A retry of the same send does not duplicate it.
      sent = [];
      expect(await runSubprocessorNoticeSweep(new Date('2026-10-20T13:00:00Z'), ROWS)).toEqual({ accountsNotified: 0 });
      expect(customerEmails()).toEqual([]);
    } finally {
      await deleteFromView(db, accountMembers, eq(accountMembers.userId, owner));
      for (const accountId of [batchA.account_id, batchB.account_id]) {
        await db.delete(creditAccounts).where(eq(creditAccounts.accountId, accountId));
      }
      await db.execute(sql`delete from kortix.chat_event_dedup where event_id like ${`%${batchA.account_id}%`} or event_id like ${`%${batchB.account_id}%`}`);
      await removeSeeded([batchA, batchB]);
      await db.execute(sql`delete from auth.users where id = ${owner}::uuid`);
    }
  });

  test('a notice that starts late tells privacy@ how many days it gave', async () => {
    // Added 2026-10-01, effective 2026-11-07, first seen on prod 2026-10-20: a 10-day-late release.
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-10-01' }];
    await runSubprocessorNoticeSweep(new Date('2026-10-20T09:00:00Z'), rows);
    const [report] = privacyReports();
    expect(report!.subject).toBe('[Dosco compliance] Subprocessor notice gave only 17 days');
    expect(report!.text).toContain('Send no customer data to these subprocessors until 30 days from now');
  });

  test('outside prod the sweep emails nobody', async () => {
    config.INTERNAL_KORTIX_ENV = 'dev';
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-10-21' }];
    expect(await runSubprocessorNoticeSweep(new Date('2026-10-21T09:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });
});
