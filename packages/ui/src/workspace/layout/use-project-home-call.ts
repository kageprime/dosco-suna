'use client';

import { writeStartStash } from '@kortix/sdk/react';
import { useMemo } from 'react';

import { useIsCreatingProjectSession } from '../../internal/hooks/projects/new-session-guard';
import { useNewProjectSession } from '../../internal/hooks/projects/use-new-project-session';
import type { ComposerOptions } from '../../session/composer/composer-chat-input';
import { useVoiceCallsEnabled } from '../../session/voice/composer-call';
import { useVoiceCallStore } from '../../session/voice/voice-call-store';
import { buildNewSessionCreateInput } from './new-session-create';

/**
 * What the home composer's call carries: its picks (`ComposerOptions`, with the agent it shows: the composer offers
 * a call only once it resolved one) and the sandbox template chosen beside it.
 */
export type ProjectHomeCallOptions = ComposerOptions & { agent: string; sandbox_slug?: string };

/**
 * The project home composer's voice call: with nothing typed, its button calls instead of sending. A call is a new
 * session, as a send is: the same create (agent, sandbox, connectors, secrets, through `useNewProjectSession` with
 * its billing, connector and double-click guards), with no first prompt. The call is placed as the create lands and
 * the session opens, so the conversation fills its chat while the person talks.
 *
 * `beforeSend` is the host's own gate (apps/web checks the account's billing state): it runs first, and a throw
 * places nothing. Undefined while the project's `voice_call` flag is off: the composer keeps the plain Send.
 */
export function useProjectHomeCall(
  projectId: string,
  { beforeSend }: { beforeSend?: () => Promise<void> } = {},
): { onCall: (options: ProjectHomeCallOptions) => void; inCall: boolean } | undefined {
  const enabled = useVoiceCallsEnabled(projectId);
  const startSession = useNewProjectSession(projectId);
  const creating = useIsCreatingProjectSession(projectId);
  const inCall = useVoiceCallStore((s) => !!s.call);
  return useMemo(() => {
    if (!enabled) return undefined;
    return {
      // A create in flight holds the button too: the guard would drop a second click anyway.
      inCall: inCall || creating,
      onCall: (options: ProjectHomeCallOptions) => {
        void (async () => {
          try {
            await beforeSend?.();
          } catch {
            return;
          }
          startSession({
            create: buildNewSessionCreateInput(options),
            scope: options.scope,
            onNavigate: (sessionId) => {
              // The picks the composer showed, for the session's own composer: a message typed during the call runs
              // on them, as a first send's would (`useProjectHomeSend`).
              writeStartStash(sessionId, {
                prompt: '',
                agent: options.agent,
                model: options.model ?? null,
                variant: options.variant ?? null,
              });
              useVoiceCallStore.getState().place({ projectId, sessionId, agent: options.agent });
            },
          });
        })();
      },
    };
  }, [enabled, inCall, creating, beforeSend, startSession, projectId]);
}
