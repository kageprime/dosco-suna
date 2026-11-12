'use client';

import { platformConfig } from '@kortix/sdk';
import { useFeatureFlag } from '@kortix/sdk/react';
import { useMemo } from 'react';

import { useProjectCanRun } from '../../internal/hooks/projects/use-project-can-run';
import { isDesktop } from '../../internal/lib/desktop-detect';
import { useUpgradeDialogStore } from '../../internal/stores/upgrade-dialog-store';
import { useVoiceCallStore } from './voice-call-store';

/**
 * The voice call an empty composer offers in Send's place, as a phone's chat app does: with a draft the button sends
 * it, with none it calls. `SendStopControl` draws it; a host that passes none keeps the plain Send. The call itself
 * runs in the call card (voice-call-card.tsx, in the project shell), wherever the person goes in the project.
 */
export interface ComposerCall {
  /** Places the call. */
  onCall: () => void;
  /** A call is in progress already. One microphone, one call: the button stays, disabled, and says so. */
  inCall: boolean;
}

/**
 * Whether this project may place a voice call from here: the project's `voice_call` flag is on, the host mounts a
 * call card to run it (`VoiceCallCard`: apps/web's project shell does, a white-label host may not), and the page is
 * not the desktop shell, whose signed app has no microphone entitlement yet (apps/desktop-electron).
 */
export function useVoiceCallsEnabled(projectId: string | undefined): boolean {
  const { enabled } = useFeatureFlag(projectId ?? null, 'voice_call');
  const runnable = useVoiceCallStore((s) => s.cards > 0);
  return enabled && runnable && !!projectId && !isDesktop();
}

/**
 * A call with the session `sessionId` from its own composer. The session's agent answers in this same chat: the
 * box's voice relay binds every top-level session under its Kortix session id (packages/voice), so the call's turns
 * are this session's turns. A sub-session (`topLevel: false`) has no relay and gets no call.
 *
 * `agent` names the call card's mark and name; the relay answers as the session's own agent either way.
 */
export function useSessionComposerCall({
  projectId,
  sessionId,
  agent,
  topLevel = true,
}: {
  projectId: string | undefined;
  /** The Kortix session id (`project_sessions.session_id`), never a runtime conversation id. */
  sessionId: string | undefined;
  agent: string | null | undefined;
  topLevel?: boolean;
}): ComposerCall | undefined {
  const enabled = useVoiceCallsEnabled(projectId);
  const inCall = useVoiceCallStore((s) => !!s.call);
  const { canRun, isLoading: billingLoading, accountId } = useProjectCanRun(enabled ? projectId : undefined);
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  return useMemo(() => {
    if (!enabled || !projectId || !sessionId || !agent || !topLevel) return undefined;
    return {
      inCall,
      onCall: () => {
        // The gate Start session and the agent page's Call apply: a call runs billed turns.
        if (platformConfig().billingEnabled && !billingLoading && !canRun) {
          openUpgradeDialog({ reason: 'subscription_required', accountId });
          return;
        }
        useVoiceCallStore.getState().place({ projectId, sessionId, agent });
      },
    };
  }, [enabled, projectId, sessionId, agent, topLevel, inCall, billingLoading, canRun, openUpgradeDialog, accountId]);
}
