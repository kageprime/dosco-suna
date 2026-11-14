import { wallet } from '../../billing/wallet';

/** The account and amount a refund needs; both reservation types satisfy it. */
export interface Reservation {
  accountId: string;
  cost: number;
}

/**
 * Refund a reservation: the reserved account credits under their ledger `kind`.
 * No-op for a null reservation or a zero amount.
 */
export async function refundReservation(
  reservation: Reservation | null,
  kind: string,
  description: string,
): Promise<void> {
  if (!reservation || reservation.cost <= 0) return;
  await wallet.grant({
    accountId: reservation.accountId,
    amount: reservation.cost,
    kind,
    description,
    expiring: false,
    key: null,
  });
}
