import { useTranslations } from '@/i18n/use-translations';
/**
 * The MFA state machine shared by every surface that lets a member manage
 * their own second factor (authenticator app / TOTP): the factor list, the
 * current session's `aal` level, and the enroll / verify / remove /
 * cancel-enroll mutations.
 *
 * Extracted from `features/accounts/settings/security-tab.tsx` (Task 10) —
 * `features/workspace/settings/tabs/profile-tab.tsx` had re-implemented the
 * same ~90 lines of orchestration by hand (Task 7's port), which left two
 * copies reading and writing the same `['mfa-factors']` / `['mfa-aal']`
 * query keys. Diffing them line-for-line before extracting turned up no
 * behavioural divergence — only cosmetic renames (`code` vs `enrollCode`,
 * `setRemoveTarget` vs `setRemoveFactorTarget`) and a defensive
 * `if (enrolling)` guard around the cancel-enroll cleanup that
 * `profile-tab.tsx` had added but that never changes behaviour, since the
 * Cancel button that calls it only ever renders while `enrolling` is set.
 * That guarded version is what this hook keeps.
 *
 * KRTX-4748 merged the phone-verification page's second copies of these
 * queries (its own factor key + a second `['mfa-aal']` policy) into this
 * file; the four phone challenge mutations moved here too, so this module is
 * the one home every MFA hook is imported from.
 *
 * `FactorRow` (the pure per-factor row) and `totpQrSrc` (the QR data-URL
 * normalizer) are NOT here — they're view code, not state, and this file
 * stays hook-only (`.ts`, no JSX). They now live in `profile-tab.tsx`, their
 * sole remaining consumer.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { errorToast, successToast } from '@kortix/ui/toast';
import { invalidateTokenCache } from '@/lib/auth-token';
import { useAuth } from '@/features/providers/auth-provider';
import {
  mfaChallengeRequired,
  supabaseMFAService,
  type EnrollingFactor,
} from '@/lib/supabase/mfa';

export type { EnrollingFactor };

export const MFA_FACTORS_QUERY_KEY = ['mfa-factors'] as const;
export const MFA_AAL_QUERY_KEY = ['mfa-aal'] as const;

// One factor-list cache entry for both surfaces (the Security tab and the
// phone-verification page, KRTX-4748): the phone page previously read the
// same service under its own key, so a factor enrolled there never
// invalidated the list the Security tab renders. The enabled guard is the
// phone copy's (the page runs pre-login, where `listFactors` throws) and the
// short staleTime the Security-tab copy's. Finite window so enrolled/
// unenrolled factors picked up elsewhere refetch on mount/focus (mutations
// still invalidate explicitly) — was Infinity, which never refetched despite
// the "2 minutes" intent.
export function useMfaFactors() {
  const { user } = useAuth();

  return useQuery({
    queryKey: MFA_FACTORS_QUERY_KEY,
    queryFn: () => supabaseMFAService.listFactors(),
    enabled: !!user,
    staleTime: 10_000,
  });
}

export function useMfa() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [enrolling, setEnrolling] = useState<EnrollingFactor | null>(null);
  const [enrollCode, setEnrollCode] = useState('');
  const [removeFactorTarget, setRemoveFactorTarget] = useState<string | null>(null);

  const factorsQuery = useMfaFactors();

  const aalQuery = useQuery({
    queryKey: MFA_AAL_QUERY_KEY,
    queryFn: () => supabaseMFAService.getAAL(),
    enabled: !!user,
    staleTime: 10_000,
  });

  const startEnrollMutation = useMutation({
    mutationFn: () => supabaseMFAService.enrollTotp(),
    onSuccess: (data) => {
      setEnrolling(data);
      setEnrollCode('');
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text733fee9d77dd')),
  });

  const removeFactorMutation = useMutation({
    mutationFn: (factorId: string) => supabaseMFAService.unenrollFactor(factorId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text4d6aef31f31e'));
      setRemoveFactorTarget(null);
      queryClient.invalidateQueries({ queryKey: MFA_FACTORS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: MFA_AAL_QUERY_KEY });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text787a50e3458b')),
  });

  const verifyEnrollMutation = useMutation({
    mutationFn: async () => {
      if (!enrolling) throw new Error('No enrollment in progress');
      await supabaseMFAService.challengeAndVerify({
        factor_id: enrolling.factorId,
        code: enrollCode,
      });
    },
    onSuccess: () => {
      // Verifying the first factor elevates this session to aal2. Bust the
      // 30s token cache so the next gated request uses the new token instead
      // of replaying the stale aal1 one.
      invalidateTokenCache();
      successToast(tI18nComplete.raw('text37635d11f518'));
      setEnrolling(null);
      setEnrollCode('');
      // Refetch every active query so data that 403'd while aal1 (projects,
      // API keys, members) repopulates on its own — no manual page reload,
      // and the MFA error banners on those screens clear.
      queryClient.invalidateQueries();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('texte7307911656c')),
  });

  const cancelEnroll = () => {
    // Abandoning enrollment leaves an unverified factor behind — clean it up
    // so the list doesn't accumulate ghosts. Silently: the person cancelled,
    // they did not remove a factor, so no "Factor removed" toast. A failed
    // cleanup is harmless — the next enrollment clears unverified factors.
    if (enrolling) {
      void supabaseMFAService
        .unenrollFactor(enrolling.factorId)
        .catch(() => {})
        .finally(() => queryClient.invalidateQueries({ queryKey: MFA_FACTORS_QUERY_KEY }));
    }
    setEnrolling(null);
    setEnrollCode('');
  };

  return {
    factors: factorsQuery.data?.factors ?? [],
    factorsLoading: factorsQuery.isLoading,
    factorsError: factorsQuery.isError,
    onRetryFactors: () => factorsQuery.refetch(),
    sessionVerified: aalQuery.data?.current_level === 'aal2',
    /** This session still owes a TOTP challenge before sensitive actions
     *  (KRTX-1386): a verified TOTP factor is enrolled and the session is aal1.
     *  `requestMfaStepUp` (mfa-step-up.tsx) turns it into "ask for the code
     *  first". */
    challengeRequired: mfaChallengeRequired(aalQuery.data),

    enrolling,
    enrollCode,
    setEnrollCode,
    startEnroll: () => startEnrollMutation.mutate(),
    isStartingEnroll: startEnrollMutation.isPending,
    verifyEnroll: () => verifyEnrollMutation.mutate(),
    isVerifyingEnroll: verifyEnrollMutation.isPending,
    cancelEnroll,

    removeFactorTarget,
    setRemoveFactorTarget,
    confirmRemoveFactor: () =>
      removeFactorTarget && removeFactorMutation.mutate(removeFactorTarget),
    isRemovingFactor: removeFactorMutation.isPending,
  };
}

// The phone-verification challenge mutations. Their onSuccess invalidates
// this module's exported key constants, so an enroll or verify on the
// phone-verification page reaches the Security tab's cache entry directly.
function invalidateMfaCaches(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: MFA_FACTORS_QUERY_KEY });
  queryClient.invalidateQueries({ queryKey: MFA_AAL_QUERY_KEY });
}

export const useEnrollPhoneNumber = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: supabaseMFAService.enrollPhoneNumber,
    onSuccess: () => {
      // Invalidate factors list after enrollment
      invalidateMfaCaches(queryClient);
    },
  });
};

export const useCreateChallenge = () => {
  return useMutation({
    mutationFn: supabaseMFAService.createChallenge,
  });
};

export const useVerifyChallenge = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: supabaseMFAService.verifyChallenge,
    onSuccess: () => {
      // Invalidate all phone verification related caches after successful verification
      invalidateMfaCaches(queryClient);
    },
  });
};

export const useUnenrollFactor = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: supabaseMFAService.unenrollFactor,
    onSuccess: () => {
      // Invalidate caches after unenrolling
      invalidateMfaCaches(queryClient);
    },
  });
};
