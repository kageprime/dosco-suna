
/**
 * The credit ledger row model and its labels, shared by every ledger view.
 *
 * Account settings (Usage → Credit ledger) feeds it from
 * `GET /billing/transactions`; the admin account sheet feeds it from
 * `GET /admin/api/accounts/{id}/ledger`. Both are the same `credit_ledger`
 * rows, and both render through `CreditActivityFeed`, so an operator looking
 * at a support ticket sees exactly what the customer sees.
 *
 * The admin adapter lives in `app/admin/accounts/ledger-rows.ts`.
 */

import { Badge } from '@kortix/ui/badge';
import { APP_REGISTRY_TRANSLATION_KEYS } from '@kortix/ui/i18n/ui-catalog/app-registry-translation-keys.generated';
import { localizeUiCatalog } from '@kortix/ui/i18n';
import { formatUsdAsCredits } from '@kortix/shared';

/** One `credit_ledger` row, normalized across the two endpoints. */
export interface CreditTransactionRow {
  id: string;
  /** ISO-8601, or null when the source has no timestamp. */
  createdAt: string | null;
  /** Raw ledger type, e.g. `admin_grant`. Labelled by {@link creditTransactionBadge}. */
  type: string;
  description: string | null;
  /** Absent = the source does not say, and the Credit type cell stays empty. */
  isExpiring?: boolean;
  expiresAt?: string | null;
  amount: number;
  balanceAfter: number;
}

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

export const TRANSACTION_BADGES: Record<string, { label: string; variant: BadgeVariant }> = {
  tier_grant: { label: 'Tier Grant', variant: 'default' },
  free_tier_grant: { label: 'Tier Grant', variant: 'secondary' },
  purchase: { label: 'Purchase', variant: 'default' },
  auto_topup: { label: 'Auto Top-up', variant: 'default' },
  topup_bonus: { label: 'Top-up Bonus', variant: 'secondary' },
  machine_bonus: { label: 'Machine Bonus', variant: 'secondary' },
  admin_grant: { label: 'Admin Grant', variant: 'secondary' },
  promotional: { label: 'Promotional', variant: 'secondary' },
  daily_refresh: { label: 'Daily Refresh', variant: 'secondary' },
  usage: { label: 'Usage', variant: 'outline' },
  llm_debit: { label: 'LLM', variant: 'outline' },
  token_deduction: { label: 'LLM', variant: 'outline' },
  token_overage: { label: 'LLM Overage', variant: 'outline' },
  compute_debit: { label: 'Sandbox', variant: 'outline' },
  compute_refund: { label: 'Sandbox Refund', variant: 'secondary' },
  llm_reservation_refund: { label: 'LLM Hold Refund', variant: 'secondary' },
  proxy_debit: { label: 'Proxy', variant: 'outline' },
  storage_debit: { label: 'Storage', variant: 'outline' },
  refund: { label: 'Refund', variant: 'secondary' },
  adjustment: { label: 'Adjustment', variant: 'outline' },
  expired: { label: 'Expired', variant: 'destructive' },
};

/** The badges in the active locale. `t` is `useTranslations('hardcodedUi.i18nComplete')`. */
export function localizedTransactionBadges(
  t: Parameters<typeof localizeUiCatalog>[1],
): typeof TRANSACTION_BADGES {
  return localizeUiCatalog(TRANSACTION_BADGES, t, APP_REGISTRY_TRANSLATION_KEYS);
}

/**
 * Label and badge variant for a ledger type. An unknown type renders as its own
 * key — new types ship from the API before the UI learns them, and a raw key
 * beats a blank cell.
 */
export function creditTransactionBadge(type: string): { label: string; variant: BadgeVariant } {
  return TRANSACTION_BADGES[type] ?? { label: type, variant: 'outline' };
}

/**
 * A ledger amount in credits with its sign: `+2,500`, `-125`. A debit too
 * small to show reads `<0.01` with no sign (`-<0.01` is two symbols for one
 * idea); a credit that small keeps its `+`, so a tiny refund and a tiny
 * charge still read differently.
 */
export function formatSignedCredits(usd: number): string {
  const magnitude = formatUsdAsCredits(Math.abs(usd));
  if (magnitude.startsWith('<')) return usd > 0 ? `+${magnitude}` : magnitude;
  return `${usd < 0 && magnitude !== '0' ? '-' : '+'}${magnitude}`;
}
