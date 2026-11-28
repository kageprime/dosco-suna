/**
 * SessionTranscriptShareRow — the top of the Share view (KRTX-248): native
 * share of a plain-text transcript.
 *
 * Hidden until the device holds the session's messages. A tap first reads the
 * whole history (`loadSessionExportMessages`: the session log, else the
 * runtime while the computer runs; the row reads "Loading…"), then shares
 * `buildTranscriptText`. A failed read shares what the thread holds, with a
 * "may not be included" line.
 *
 * The public transcript link (Share link, Stop sharing link) is gone: the API
 * removed public transcript sharing (KRTX-2358) and answers 400 to every
 * create.
 */
import * as React from 'react';
import { Share } from 'react-native';

import { SettingsGroup, SettingsRow } from '@/components/kortix/settings-list';
import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { FileTextIcon } from '@/lib/icons';
import { sessionLogOfV1Rows, type SessionLogMessage } from '@kortix/sdk';
import { loadSessionExportMessages, useSessionLogThread } from '@kortix/sdk/react';
import type { ProjectSession } from '@/lib/projects/projects-client';
import { sessionDisplayTitle } from '@/lib/session/session-list';
import { buildTranscriptText } from '@/lib/session/transcript-text';

interface SessionTranscriptShareRowProps {
  projectId: string;
  session: ProjectSession;
}

export function SessionTranscriptShareRow({ projectId, session }: SessionTranscriptShareRowProps) {
  const toast = useToast();
  const title = sessionDisplayTitle(session);

  // The transcript is the session log's root thread (the runtime session's rows on v1).
  const runtimeSessionId = session.runtime_session_id;
  const source = React.useMemo(
    () => ({ projectId, sessionId: session.session_id, runtimeSessionId: runtimeSessionId ?? null }),
    [projectId, session.session_id, runtimeSessionId],
  );
  const thread = useSessionLogThread(source);
  const hasMessages = (thread?.messages.length ?? 0) > 0;

  const [loadingHistory, setLoadingHistory] = React.useState(false);
  // False once the Share view unmounts (Back, sheet closed): a history load
  // still running then must not open the share sheet or a toast.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const shareTranscript = async () => {
    if (!runtimeSessionId || loadingHistory) return;
    haptics.tap();
    setLoadingHistory(true);
    // The thread holds only its newest page: read the whole history, from the
    // session log, else from the runtime while the computer runs. A failed read
    // shares what the thread holds, marked incomplete.
    let messages: readonly SessionLogMessage[] = [];
    let complete = false;
    try {
      const rows = await loadSessionExportMessages(runtimeSessionId, `${projectId}/${session.session_id}`);
      messages = sessionLogOfV1Rows(session.session_id, runtimeSessionId, rows).threads[0]?.messages ?? [];
      complete = true;
    } catch {
      messages = thread?.messages ?? [];
    } finally {
      if (mountedRef.current) setLoadingHistory(false);
    }
    if (!mountedRef.current) return;
    const text = messages.length > 0 ? buildTranscriptText(title, messages, { incomplete: !complete }) : null;
    if (!text) {
      toast.error('Nothing to share yet.');
      return;
    }
    try {
      await Share.share({ message: text }, { subject: title });
    } catch {
      haptics.warning();
      toast.error('Unable to open sharing. Try again.');
    }
  };

  if (!hasMessages) return null;
  return (
    <SettingsGroup>
      <SettingsRow
        icon={FileTextIcon}
        label="Share transcript"
        value={loadingHistory ? 'Loading…' : undefined}
        disabled={loadingHistory}
        right={null}
        onPress={() => void shareTranscript()}
      />
    </SettingsGroup>
  );
}
