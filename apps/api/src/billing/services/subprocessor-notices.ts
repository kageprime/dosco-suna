/**
 * The 30-day notice before a new subprocessor processes customer personal data
 * (DPA section 7.3). The list and its rules live in
 * `@kortix/shared/subprocessors`: a row with `addedOn` is announced from the
 * first sweep that sees it on prod until it takes effect.
 *
 * Each open notice goes once to every person who is a billing manager (owner
 * or admin) of a paid account, listing the paid workspaces they manage (or
 * "all workspaces" when that is every paid account): a claim row per account
 * in `chat_event_dedup` makes the notice once-only across replicas and
 * sweeps. Prod only, so a dev or staging deploy of the list emails nobody.
 *
 * Evidence: each notified account gets a `legal.subprocessor_notice.sent`
 * audit event (it shows in that account's audit log), and privacy@dosco.live
 * gets a summary of every sweep that sent, flagged when it gave fewer than 30
 * days.
 */
import { chatEventDedup, creditAccounts } from '@kortix/db';
import {
  formatSubprocessorDate,
  SUBPROCESSOR_NOTICE_DAYS,
  subprocessorEffectiveDate,
  SUBPROCESSORS_CORE,
  SUBPROCESSORS_OPTIONAL,
  type Subprocessor,
} from '@kortix/shared/subprocessors';
import { isNotNull, notInArray, and, eq } from 'drizzle-orm';
import { config } from '../../config';
import { renderEmail, renderText, S, actionButton } from '../../lib/email/template';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { recordAuditEvent } from '../../shared/audit';
import { escapeHtml } from '../../shared/html';
import { claimOnce } from './access-notices';
import { billingManagers, sendAlertEmail } from './owner-alerts';

const PRIVACY_EMAIL = 'privacy@dosco.live';

export type SubprocessorNotice = { addedOn: string; effectiveDate: string; rows: Subprocessor[] };

/** The notices open on `today` (`YYYY-MM-DD`): added, not yet in effect. One per `addedOn` day. */
export function openSubprocessorNotices(rows: readonly Subprocessor[], today: string): SubprocessorNotice[] {
  const byDate = new Map<string, SubprocessorNotice>();
  for (const row of rows) {
    const effectiveDate = subprocessorEffectiveDate(row);
    if (!row.addedOn || !effectiveDate || row.addedOn > today || effectiveDate <= today) continue;
    const notice = byDate.get(row.addedOn) ?? { addedOn: row.addedOn, effectiveDate, rows: [] };
    notice.rows.push(row);
    byDate.set(row.addedOn, notice);
  }
  return [...byDate.values()];
}

/** The "owner or admin of ___" phrase: the workspace names, or "all workspaces" when the person manages every paid account. */
export function workspaceScope(names: string[], paidTotal: number): string {
  const unique = [...new Set(names)];
  if (unique.length > 1 && unique.length === paidTotal) return 'all workspaces';
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(unique);
}

function compose(notice: SubprocessorNotice, scope: string) {
  const url = `${(config.FRONTEND_URL || 'https://dosco.live').replace(/\/+$/, '')}/legal/subprocessors`;
  const effective = formatSubprocessorDate(notice.effectiveDate);
  const title = 'New Dosco subprocessors';
  const intro = `Dosco will add the subprocessors below on ${effective}. Until then they process no customer personal data. You receive this notice as an owner or admin of ${scope}, as our Data Processing Addendum (section 7.3) requires.`;
  const outro = `To object, reply to this email or write to ${PRIVACY_EMAIL} before ${effective}.`;
  const items = notice.rows.map((row) => `${row.name}: ${row.purpose} (${row.location})`);
  return {
    subject: `Dosco subprocessor update, effective ${effective}`,
    category: 'legal-subprocessor-notice',
    replyTo: PRIVACY_EMAIL,
    html: renderEmail({
      title,
      body: `<p style="${S.p}">${escapeHtml(intro)}</p>${items.map((item) => `<p style="${S.p}">${escapeHtml(item)}</p>`).join('')}<p style="${S.p}">${escapeHtml(outro)}</p>${actionButton(url, 'View all subprocessors')}`,
    }),
    text: renderText({ title, paragraphs: [intro, ...items, outro], cta: { url, label: 'View all subprocessors' } }),
  };
}

/** The hourly sweep: email each open notice once per person, listing the paid workspaces it covers. */
export async function runSubprocessorNoticeSweep(
  now: Date = new Date(),
  rows: readonly Subprocessor[] = [...SUBPROCESSORS_CORE, ...SUBPROCESSORS_OPTIONAL],
): Promise<{ accountsNotified: number }> {
  if (config.INTERNAL_KORTIX_ENV !== 'prod') return { accountsNotified: 0 };
  const notices = openSubprocessorNotices(rows, now.toISOString().slice(0, 10));
  if (notices.length === 0) return { accountsNotified: 0 };

  const paid = await db
    .select({ accountId: creditAccounts.accountId })
    .from(creditAccounts)
    .where(and(isNotNull(creditAccounts.tier), notInArray(creditAccounts.tier, ['free', 'none'])));
  let accountsNotified = 0;
  for (const notice of notices) {
    // Claim per account first (the idempotency key of the notice), then group
    // the claimed workspaces by recipient inbox: one email per person, not one
    // per project (KRTX-4819).
    const claimed: { accountId: string; accountName: string; emails: string[] }[] = [];
    for (const { accountId } of paid) {
      const claim = `legal:subprocessor-notice:${notice.addedOn}:${accountId}`;
      if (!(await claimOnce(claim))) continue;
      try {
        const { emails, accountName } = await billingManagers(accountId);
        // Nobody to email yet: release the claim so a later sweep retries the account.
        if (emails.length === 0) {
          await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claim));
          continue;
        }
        claimed.push({ accountId, accountName, emails });
      } catch (err) {
        logger.warn('[subprocessor-notices] notice failed', { accountId, error: (err as Error).message });
      }
    }
    const inboxes = new Map<string, string[]>();
    for (const { accountName, emails } of claimed) {
      for (const to of emails) inboxes.set(to, [...(inboxes.get(to) ?? []), accountName]);
    }
    const sent = new Set<string>();
    for (const [to, workspaces] of inboxes) {
      try {
        await sendAlertEmail({ ...compose(notice, workspaceScope(workspaces, paid.length)), to: [to] });
        sent.add(to);
      } catch (err) {
        logger.warn('[subprocessor-notices] notice failed', { to, error: (err as Error).message });
      }
    }
    // Evidence: one audit event per notified account, once per notice. The
    // count follows the sends (what the privacy report describes), not the
    // audit writes.
    let sentThisSweep = 0;
    for (const { accountId, emails } of claimed) {
      const recipients = emails.filter((to) => sent.has(to)).length;
      if (recipients === 0) continue;
      sentThisSweep++;
      try {
        await recordAuditEvent({
          accountId,
          actorType: 'system',
          action: 'legal.subprocessor_notice.sent',
          resourceType: 'subprocessor_notice',
          resourceId: notice.addedOn,
          outputSummary: {
            recipients,
            effective_date: notice.effectiveDate,
            subprocessors: notice.rows.map((row) => row.name),
          },
        });
      } catch (err) {
        logger.warn('[subprocessor-notices] audit failed', { accountId, error: (err as Error).message });
      }
    }
    if (sent.size > 0) await reportToPrivacy(notice, sentThisSweep, now);
    accountsNotified += sentThisSweep;
  }
  return { accountsNotified };
}

/** The compliance record: what went out, to how many accounts, and how much notice it gave. */
async function reportToPrivacy(notice: SubprocessorNotice, accounts: number, now: Date) {
  const days = Math.floor((Date.parse(`${notice.effectiveDate}T00:00:00Z`) - now.getTime()) / 86_400_000);
  const late = days < SUBPROCESSOR_NOTICE_DAYS;
  const title = late
    ? `Subprocessor notice gave only ${days} days`
    : `Subprocessor notice sent to ${accounts} accounts`;
  const paragraphs = [
    `The notice for the subprocessors added ${notice.addedOn} went to the owners and admins of ${accounts} paid accounts in this sweep. It takes effect ${formatSubprocessorDate(notice.effectiveDate)}, ${days} days from now.`,
    ...notice.rows.map((row) => `${row.name}: ${row.purpose} (${row.location})`),
    ...(late
      ? [`The DPA promises ${SUBPROCESSOR_NOTICE_DAYS} days. Send no customer data to these subprocessors until ${SUBPROCESSOR_NOTICE_DAYS} days from now, and move their addedOn in packages/shared/src/subprocessors.ts so the page shows that date.`]
      : []),
    'Each notified account has a legal.subprocessor_notice.sent audit event.',
  ];
  logger.info('[subprocessor-notices] notices sent', { addedOn: notice.addedOn, accounts, days });
  await sendAlertEmail({
    to: [PRIVACY_EMAIL],
    subject: `[Dosco compliance] ${title}`,
    category: 'legal-subprocessor-notice-report',
    html: renderEmail({
      title,
      body: paragraphs.map((p) => `<p style="${S.p}">${escapeHtml(p)}</p>`).join(''),
    }),
    text: renderText({ title, paragraphs }),
  }).catch((err) => logger.warn('[subprocessor-notices] privacy report failed', { error: (err as Error).message }));
}
