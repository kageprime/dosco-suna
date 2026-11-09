'use client';

/**
 * Runtime recovery for the chat thread — owns the restart mutation, the down
 * state, and the one-shot auto-reconnect guard, so Thread renders messages and
 * inputs only.
 *
 * Sandboxes idle-stop (and die) in the real world. Rather than silently
 * disabling the composer (so Enter "does nothing"), surface the state and
 * recover: restart() wakes the box and re-arms useSession's /start poll.
 *
 * The host app supplies its own seam: `restart` makes the app's SDK restart
 * call and `sessionStartKey` is the app's query key for the session-start read.
 */

import type { UseSessionResult } from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';

/** The session fields the recovery guard reads. `UseSessionResult` satisfies it. */
export type RecoverySession = Pick<
  UseSessionResult,
  'projectId' | 'sessionId' | 'runtimePhase' | 'switched'
>;

export function useRuntimeRecovery(
  session: RecoverySession,
  seam: { restart: () => Promise<unknown>; sessionStartKey: readonly unknown[] },
) {
  const qc = useQueryClient();
  const restart = useMutation({
    mutationFn: seam.restart,
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: seam.sessionStartKey,
      });
      successToast('Reconnecting the runtime…');
    },
    onError: () => errorToast('Could not reconnect the runtime'),
  });

  const runtimeReady = session.runtimePhase === 'ready';
  // "Down" = was connected, now confirmed unreachable (a drop, not the initial boot).
  const runtimeDown = session.switched && session.runtimePhase === 'unreachable';

  // Auto-reconnect ONCE per down-episode. The ref guard prevents a restart loop
  // on a box that can't recover; the flag resets when the runtime comes back, so
  // a later drop is retried again.
  const autoTriedRef = useRef(false);
  useEffect(() => {
    if (!runtimeDown) {
      autoTriedRef.current = false;
      return;
    }
    if (autoTriedRef.current || restart.isPending) return;
    autoTriedRef.current = true;
    restart.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeDown]);

  return { restart, runtimeReady, runtimeDown };
}
