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
// Addresses whose delivery fails with this provider status ('*': every address), the way the transport reports it: a result, not a throw.
// 'reserved': the transport itself refuses the address, without a provider call.
let failing = new Map<string, number | 'reserved'>();
// Every address a send was attempted to, delivered or not.
let attempted: string[] = [];
// A send to `held.to` waits until the test settles `held.status` (0: delivered, else the provider status).
let held: { to: string; reached: () => void; status: Promise<number> } | null = null;
const customerEmails = () => sent.filter((m) => !m.subject.startsWith('[Kortix compliance]'));
const privacyReports = () => sent.filter((m) => m.subject.startsWith('[Kortix compliance]'));

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
    attempted.push(...message.to);
    const hold = held?.to === message.to[0] ? held : null;
    if (hold) {
      held = null;
      hold.reached();
    }
    const status = (await hold?.status) || failing.get(message.to[0]!) || failing.get('*');
    if (status === 'reserved') return { ok: false, skipped: true, reason: 'reserved_recipient' };
    if (status) return { ok: false, provider: 'mailpit', status, error: 'rejected' };
    sent.push(message);
    return { ok: true, provider: 'mailpit', status: 200 };
  });
}, 20_000);

beforeEach(() => {
  sent = [];
  failing = new Map();
  attempted = [];
  held = null;
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

describe('repeated sweeps of one notice', () => {
  const seeded: SeededProject[] = [];
  const users: string[] = [];

  async function seedUser(label: string): Promise<string> {
    const id = crypto.randomUUID();
    users.push(id);
    await db.execute(sql`
      insert into auth.users (id, email, instance_id, aud, role)
      values (${id}::uuid, ${email(id, label)}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated')`);
    return id;
  }

  async function seedAccount(label: string, tier: string, managers: [string, 'owner' | 'admin'][]): Promise<SeededProject> {
    const project = await seedProject(label);
    seeded.push(project);
    for (const [userId, accountRole] of managers) {
      await insertIntoView(db, accountMembers, { userId, accountId: project.account_id, accountRole });
    }
    await db.insert(creditAccounts).values({ accountId: project.account_id, tier });
    return project;
  }

  const audits = (accountId: string, addedOn: string) =>
    db
      .select({ outputSummary: auditEvents.outputSummary })
      .from(auditEvents)
      .where(and(eq(auditEvents.accountId, accountId), eq(auditEvents.action, 'legal.subprocessor_notice.sent'), eq(auditEvents.resourceId, addedOn)));
  const emailsTo = (address: string) => customerEmails().filter((m) => m.to.includes(address));

  afterAll(async () => {
    for (const userId of users) await deleteFromView(db, accountMembers, eq(accountMembers.userId, userId));
    for (const { account_id } of seeded) await db.delete(creditAccounts).where(eq(creditAccounts.accountId, account_id));
    await removeSeeded(seeded);
    for (const userId of users) await db.execute(sql`delete from auth.users where id = ${userId}::uuid`);
  });

  test('a later sweep that only finds a newly paid account emails no one twice and sends privacy@ no second warning', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-01' }];
    const person = await seedUser('repeat-owner');
    const first = await seedAccount('subproc-repeat-first', 'credits', [[person, 'owner']]);
    await runSubprocessorNoticeSweep(new Date('2026-11-02T09:00:00Z'), rows);
    expect(emailsTo(email(person, 'repeat-owner'))).toHaveLength(1);
    expect(privacyReports().map((m) => m.subject)).toEqual([expect.stringContaining('Subprocessor notice sent to')]);
    expect(await audits(first.account_id, '2026-11-01')).toHaveLength(1);

    // Unchanged inputs: nothing at all.
    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-11-02T10:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);

    // The same person's second workspace turns paid 8 days later (fewer than 30 days remain).
    const later = await seedAccount('subproc-repeat-later', 'tier_2_20', [[person, 'admin']]);
    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-11-10T09:00:00Z'), rows)).toEqual({ accountsNotified: 1 });
    expect(sent).toEqual([]);
    // The coverage of the new account is still recorded: its manager already holds the notice.
    const [audit] = await audits(later.account_id, '2026-11-01');
    expect(audit!.outputSummary).toMatchObject({ recipients: 1, previously_notified: 1, effective_date: '2026-12-08' });

    // A distinct update still reaches the same person, with its own record for privacy@.
    const update: Subprocessor = { name: 'Another Vendor, Ltd.', purpose: 'Search', location: 'Ireland', addedOn: '2026-11-10' };
    sent = [];
    await runSubprocessorNoticeSweep(new Date('2026-11-10T10:00:00Z'), [...rows, update]);
    const [notice] = emailsTo(email(person, 'repeat-owner'));
    expect(emailsTo(email(person, 'repeat-owner'))).toHaveLength(1);
    expect(notice!.text).toContain('Another Vendor, Ltd.: Search (Ireland)');
    expect(notice!.text).toContain('subproc-repeat-first-account and subproc-repeat-later-account');
    expect(privacyReports()).toHaveLength(1);
    expect(privacyReports()[0]!.text).toContain('Another Vendor, Ltd.');
  });

  test('two sweeps at once deliver each notice once per person and one report', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-03' }];
    const person = await seedUser('race-owner');
    for (const label of ['subproc-race-a', 'subproc-race-b', 'subproc-race-c']) await seedAccount(label, 'credits', [[person, 'owner']]);

    const now = new Date('2026-11-03T09:00:00Z');
    await Promise.all([runSubprocessorNoticeSweep(now, rows), runSubprocessorNoticeSweep(now, rows)]);
    const recipients = customerEmails().flatMap((m) => m.to);
    expect(recipients.length).toBe(new Set(recipients).size);
    expect(emailsTo(email(person, 'race-owner'))).toHaveLength(1);
    expect(privacyReports()).toHaveLength(1);
  });

  test('a failed delivery is retried for the recipient who missed it, not for the one who got it', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-04' }];
    const owner = await seedUser('retry-owner');
    const admin = await seedUser('retry-admin');
    const account = await seedAccount('subproc-retry', 'credits', [[owner, 'owner'], [admin, 'admin']]);

    failing = new Map([[email(admin, 'retry-admin'), 503]]);
    await runSubprocessorNoticeSweep(new Date('2026-11-04T09:00:00Z'), rows);
    expect(emailsTo(email(owner, 'retry-owner'))).toHaveLength(1);
    // Not covered yet: no audit event claims the admin was notified.
    expect(await audits(account.account_id, '2026-11-04')).toEqual([]);

    failing = new Map();
    sent = [];
    await runSubprocessorNoticeSweep(new Date('2026-11-04T10:00:00Z'), rows);
    expect(customerEmails().filter((m) => [email(owner, 'retry-owner'), email(admin, 'retry-admin')].includes(m.to[0]!)).map((m) => m.to[0])).toEqual([
      email(admin, 'retry-admin'),
    ]);
    // The retry does not repeat the privacy@ record of the first sweep.
    expect(privacyReports()).toEqual([]);
    const [audit] = await audits(account.account_id, '2026-11-04');
    expect(audit!.outputSummary).toMatchObject({ recipients: 2, previously_notified: 1, undelivered: 0 });

    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-11-04T11:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('an address the transport refuses is recorded as undelivered once, not retried every hour', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-05' }];
    const owner = await seedUser('reject-owner');
    const admin = await seedUser('reject-admin');
    const account = await seedAccount('subproc-reject', 'credits', [[owner, 'owner'], [admin, 'admin']]);

    failing = new Map([[email(admin, 'reject-admin'), 'reserved']]);
    await runSubprocessorNoticeSweep(new Date('2026-11-05T09:00:00Z'), rows);
    expect(emailsTo(email(owner, 'reject-owner'))).toHaveLength(1);
    const [audit] = await audits(account.account_id, '2026-11-05');
    expect(audit!.outputSummary).toMatchObject({ recipients: 1, previously_notified: 0, undelivered: 1 });

    attempted = [];
    await runSubprocessorNoticeSweep(new Date('2026-11-05T10:00:00Z'), rows);
    expect(attempted).toEqual([]);
    expect(await audits(account.account_id, '2026-11-05')).toHaveLength(1);
  });

  test('a provider 422 does not prove the address is bad: the account stays open and the next sweep delivers', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-13' }];
    const owner = await seedUser('invalid-owner');
    const account = await seedAccount('subproc-invalid', 'credits', [[owner, 'owner']]);

    // A payload or provider validation error (missing field, invalid parameter) answers 422 for every send.
    failing = new Map([['*', 422]]);
    await runSubprocessorNoticeSweep(new Date('2026-11-13T09:00:00Z'), rows);
    expect(attempted).toContain(email(owner, 'invalid-owner'));
    expect(await audits(account.account_id, '2026-11-13')).toEqual([]);

    failing = new Map();
    await runSubprocessorNoticeSweep(new Date('2026-11-13T10:00:00Z'), rows);
    expect(emailsTo(email(owner, 'invalid-owner'))).toHaveLength(1);
    const [audit] = await audits(account.account_id, '2026-11-13');
    expect(audit!.outputSummary).toMatchObject({ recipients: 1, previously_notified: 0, undelivered: 0 });
  });

  test('a privacy@ report that fails is sent by a later sweep, once, with the notice period of the first email', async () => {
    // Added 2026-11-06, effective 2026-12-13: the first email, at 09:00 that day, gave 36 days.
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-06' }];
    failing = new Map([['privacy@kortix.com', 503]]);
    await runSubprocessorNoticeSweep(new Date('2026-11-06T09:00:00Z'), rows);
    expect(customerEmails().length).toBeGreaterThan(0);
    expect(privacyReports()).toEqual([]);

    // Ten days later (27 days left) privacy@ is reachable again: the report is not flagged late.
    failing = new Map();
    sent = [];
    await runSubprocessorNoticeSweep(new Date('2026-11-16T09:00:00Z'), rows);
    expect(customerEmails()).toEqual([]);
    expect(privacyReports().map((m) => m.subject)).toEqual([expect.stringMatching(/^\[Kortix compliance\] Subprocessor notice sent to [1-9]\d* accounts$/)]);
    expect(privacyReports()[0]!.text).toContain('36 days after the first notice email');

    sent = [];
    await runSubprocessorNoticeSweep(new Date('2026-11-16T10:00:00Z'), rows);
    expect(sent).toEqual([]);
  });

  test('a provider-wide rejection is temporary: no account is closed, the next sweep delivers', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-07' }];
    const owner = await seedUser('outage-owner');
    const account = await seedAccount('subproc-outage', 'credits', [[owner, 'owner']]);

    // A paused or misconfigured provider answers 403 for every address, privacy@ included.
    failing = new Map([['*', 403]]);
    expect(await runSubprocessorNoticeSweep(new Date('2026-11-07T09:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(attempted).toContain(email(owner, 'outage-owner'));
    expect(sent).toEqual([]);
    expect(await audits(account.account_id, '2026-11-07')).toEqual([]);

    failing = new Map();
    await runSubprocessorNoticeSweep(new Date('2026-11-07T10:00:00Z'), rows);
    expect(emailsTo(email(owner, 'outage-owner'))).toHaveLength(1);
    const [audit] = await audits(account.account_id, '2026-11-07');
    expect(audit!.outputSummary).toMatchObject({ recipients: 1, undelivered: 0 });
    expect(privacyReports().map((m) => m.subject)).toEqual([expect.stringContaining('Subprocessor notice sent to')]);
  });

  test('a notice whose coverage started before per-report claims existed gets no new report', async () => {
    const rows: Subprocessor[] = [{ ...ROWS[1]!, addedOn: '2026-11-08' }];
    // An earlier release claimed one account and reported it; it left no report claim.
    await db.execute(sql`insert into kortix.chat_event_dedup (event_id, expires_at) values (${`legal:subprocessor-notice:2026-11-08:${paid.account_id}`}, now() + interval '1 day')`);
    const owner = await seedUser('upgrade-owner');
    await seedAccount('subproc-upgrade', 'credits', [[owner, 'owner']]);

    await runSubprocessorNoticeSweep(new Date('2026-11-30T09:00:00Z'), rows);
    expect(emailsTo(email(owner, 'upgrade-owner'))).toHaveLength(1);
    expect(privacyReports()).toEqual([]);
  });

  const VENDOR: Subprocessor = { name: 'Example Inference, Inc.', purpose: 'Inference', location: 'United States' };
  const audited = (summary: Record<string, unknown>) => [{ outputSummary: expect.objectContaining(summary) }];

  // Sweep 1 is mid-send to a manager when their other workspace turns paid and sweep 2 runs.
  async function raceWithInFlightSend(addedOn: string, label: string, firstSendStatus: number) {
    const rows: Subprocessor[] = [{ ...VENDOR, addedOn }];
    const person = await seedUser(label);
    const first = await seedAccount(`subproc-${label}-first`, 'credits', [[person, 'owner']]);
    let settle = (_status: number) => {};
    const reached = new Promise<void>((resolve) => {
      held = { to: email(person, label), reached: resolve, status: new Promise((done) => (settle = done)) };
    });
    const sweep1 = runSubprocessorNoticeSweep(new Date(`${addedOn}T09:00:00Z`), rows);
    await reached;

    const later = await seedAccount(`subproc-${label}-later`, 'tier_2_20', [[person, 'admin']]);
    await runSubprocessorNoticeSweep(new Date(`${addedOn}T09:30:00Z`), rows);
    // An email still in flight is not a delivered one: no evidence for the new account yet, no second send.
    expect(await audits(later.account_id, addedOn)).toEqual([]);
    expect(attempted.filter((to) => to === email(person, label))).toHaveLength(1);

    settle(firstSendStatus);
    await sweep1;
    sent = [];
    await runSubprocessorNoticeSweep(new Date(`${addedOn}T10:00:00Z`), rows);
    return { rows, person, first, later };
  }

  test('a send that fails while another sweep runs is retried for the account that sweep found, not recorded as delivered', async () => {
    const { rows, person, first, later } = await raceWithInFlightSend('2026-11-09', 'inflight-owner', 503);
    expect(emailsTo(email(person, 'inflight-owner'))).toEqual([
      expect.objectContaining({ text: expect.stringContaining('subproc-inflight-owner-first-account and subproc-inflight-owner-later-account') }),
    ]);
    for (const { account_id } of [first, later]) {
      expect(await audits(account_id, '2026-11-09')).toEqual(audited({ recipients: 1, previously_notified: 0, undelivered: 0 }));
    }

    sent = [];
    expect(await runSubprocessorNoticeSweep(new Date('2026-11-09T11:00:00Z'), rows)).toEqual({ accountsNotified: 0 });
    expect(sent).toEqual([]);
  });

  test('a send that succeeds while another sweep runs covers that sweep\'s account on the next sweep, with no second email', async () => {
    const { person, later } = await raceWithInFlightSend('2026-11-11', 'landed-owner', 0);
    expect(emailsTo(email(person, 'landed-owner'))).toEqual([]);
    expect(await audits(later.account_id, '2026-11-11')).toEqual(audited({ recipients: 1, previously_notified: 1, undelivered: 0 }));
  });

  test('a send claim left by a sweep that died mid-send is taken over once it is stale', async () => {
    const rows: Subprocessor[] = [{ ...VENDOR, addedOn: '2026-11-12' }];
    const owner = await seedUser('crash-owner');
    const account = await seedAccount('subproc-crash', 'credits', [[owner, 'owner']]);
    const claim = `legal:subprocessor-notice:2026-11-12:to:${new Bun.CryptoHasher('sha256').update(email(owner, 'crash-owner')).digest('hex')}`;
    await db.execute(sql`insert into kortix.chat_event_dedup (event_id, expires_at) values (${claim}, now() - interval '1 minute')`);

    await runSubprocessorNoticeSweep(new Date('2026-11-12T09:00:00Z'), rows);
    expect(emailsTo(email(owner, 'crash-owner'))).toHaveLength(1);
    expect(await audits(account.account_id, '2026-11-12')).toEqual(audited({ recipients: 1, previously_notified: 0 }));
  });
});
