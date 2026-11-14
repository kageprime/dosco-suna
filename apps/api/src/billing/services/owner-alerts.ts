/**
 * Email the billing managers of an account (KRTX-1718): the owners and admins,
 * the two roles that hold `billing.write` and can add credits, fix a card or
 * accept a plan. One helper for every billing alert: auto top-up turned off,
 * a member asking for credits, a trial or contract about to end.
 */
import { eq } from 'drizzle-orm';
import { lookupEmailsByUserIds } from '../../accounts/core/owner-emails';
import { config } from '../../config';
import { accountRoleMap } from '../../iam/read-models';
import type { EmailMessage } from '../../lib/email/types';
import { sendEmail } from '../../lib/email/transport';
import { db } from '../../shared/db';
import { accountsView } from '../../workspaces/rows';

let send = sendEmail;

/** Capture the alert emails in a test; `null` restores the real transport. */
export function setOwnerAlertSenderForTest(sender: typeof sendEmail | null): void {
  send = sender ?? sendEmail;
}

/** Hand one billing alert email to the transport (the seam above captures it in tests). */
export function sendAlertEmail(message: EmailMessage) {
  return send(message);
}

/** The account's Billing pane: the hub opened over the project list. */
export function billingPaneUrl(accountId: string): string {
  const base = (config.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}/workspaces?accountId=${encodeURIComponent(accountId)}&accountTab=billing`;
}

/**
 * The account's billing managers: their deduped email addresses and the
 * account's display name. `emails` is empty when the account has nobody to
 * email yet.
 */
export async function billingManagers(accountId: string): Promise<{ emails: string[]; accountName: string }> {
  const managers = [...(await accountRoleMap(accountId))]
    .filter(([, role]) => role === 'owner' || role === 'admin')
    .map(([userId]) => userId);
  if (managers.length === 0) return { emails: [], accountName: 'your Dosco account' };
  const [emailsByUser, [account]] = await Promise.all([
    lookupEmailsByUserIds(managers),
    db.select({ name: accountsView.name }).from(accountsView).where(eq(accountsView.accountId, accountId)).limit(1),
  ]);
  const emails = [...new Set([...emailsByUser.values()].filter((email): email is string => !!email))];
  return { emails, accountName: account?.name?.trim() || 'your Dosco account' };
}

/**
 * Email every billing manager (owner or admin) of the account the message
 * `compose` builds from the account's name. Returns how many emails were
 * handed to the transport.
 */
export async function emailBillingManagers(
  accountId: string,
  compose: (accountName: string) => Omit<EmailMessage, 'to'>,
): Promise<number> {
  const { emails, accountName } = await billingManagers(accountId);
  if (emails.length === 0) return 0;
  const message = compose(accountName);
  await Promise.all(emails.map((to) => send({ ...message, to: [to] })));
  return emails.length;
}
