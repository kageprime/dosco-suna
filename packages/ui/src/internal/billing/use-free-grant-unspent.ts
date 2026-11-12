'use client';

import type { AccountState } from '@kortix/sdk';

import { freeGrantUnspentElsewhere } from '../lib/billing/billing-gate-state';

import { useAccountState } from './use-account-state';

/**
 * Whether the person's free credits are unspent while the workspace being
 * opened has none (KRTX-4713) — the decision is `freeGrantUnspentElsewhere`;
 * this hook reads the claimed workspace's state it needs. `undefined` while
 * that read is in flight (or it errored), so a caller never decides from a
 * half-read account: hold the modal, never greet with a paywall.
 */
export function useFreeGrantUnspent(state: AccountState | null | undefined): boolean | undefined {
  const claimedWorkspaceId =
    state?.credits?.free_grant?.eligible === false
      ? (state.credits.free_grant.claimed_workspace_id ?? null)
      : null;
  const { data: claimedState } = useAccountState({
    accountId: claimedWorkspaceId ?? undefined,
    enabled: !!claimedWorkspaceId,
  });
  return freeGrantUnspentElsewhere(state, claimedState);
}
