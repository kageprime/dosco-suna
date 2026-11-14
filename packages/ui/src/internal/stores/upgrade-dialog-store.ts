import type { BillingState } from '@kortix/sdk';
import { create } from 'zustand';

export type UpgradeReason = 'subscription_required' | 'insufficient_credits' | 'no_account';

interface UpgradeDialogState {
  isOpen: boolean;
  reason: UpgradeReason;
  message: string;
  /** The account that actually needs the upgrade (the blocked account from the
   *  402 — e.g. the project's owning team account). `undefined` falls back to the
   *  user's primary account. The dialog scopes its billing state + subscribe
   *  action to this, so a non-billing member sees the *team's* gated CTA, not
   *  their own personal account's. */
  accountId?: string;
  /** From the 402 body — lets the modal show the top-up view (paid wallet
   *  drained) vs the plan picker (no plan) without guessing off tier_key. */
  hasSubscription?: boolean;
  /** The unambiguous state behind the block (lib/billing/billing-gate-state.ts).
   *  `reason` is the legacy 402 code and is lossy; this is what the modal picks
   *  its view and its copy from, so the gate that opened it and the modal can
   *  never say opposite things about the same account. */
  billingState?: BillingState;
  /** The Credits tier the person last picked in the dialog. Reopening the
   *  dialog keeps it, so it opens on the entry tier only until they pick. */
  pickedMonthlyUsd?: number;
  setPickedMonthlyUsd: (monthlyUsd: number) => void;
  openUpgradeDialog: (opts: {
    reason?: UpgradeReason;
    message?: string;
    accountId?: string;
    hasSubscription?: boolean;
    billingState?: BillingState;
  }) => void;
  closeUpgradeDialog: () => void;
}

export const useUpgradeDialogStore = create<UpgradeDialogState>((set) => ({
  isOpen: false,
  reason: 'subscription_required',
  message: '',
  accountId: undefined,
  hasSubscription: undefined,
  billingState: undefined,
  pickedMonthlyUsd: undefined,
  setPickedMonthlyUsd: (monthlyUsd) => set({ pickedMonthlyUsd: monthlyUsd }),
  openUpgradeDialog: (opts) =>
    set({
      isOpen: true,
      reason: opts.reason ?? 'subscription_required',
      message: opts.message ?? '',
      accountId: opts.accountId,
      hasSubscription: opts.hasSubscription,
      billingState: opts.billingState,
    }),
  closeUpgradeDialog: () => set({ isOpen: false }),
}));
