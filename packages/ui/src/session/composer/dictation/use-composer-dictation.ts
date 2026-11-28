'use client';

import { ApiError, getDictationInfo, transcribeDictation } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { useTranslations } from '../../../i18n';
import { isDesktop } from '../../../internal/lib/desktop-detect';
import { useUpgradeDialogStore } from '../../../internal/stores/upgrade-dialog-store';
import { errorToast, infoToast } from '../../../primitives/toast';
import type { ComposerEditorHandle } from '../editor/composer-editor';
import { DICTATION_BARS, dictationInsert, pushLevel } from './dictation-state';
import { DictationRecorder, MicrophoneError } from './recorder';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface ComposerDictation {
  phase: DictationPhase;
  /** Live meter levels (0..1), newest last. */
  levels: number[];
  elapsedMs: number;
  maxSeconds: number;
  creditsPerMinute: number;
  start: () => void;
  /** Stop recording and put the words into the composer. */
  finish: () => void;
  /** Drop the recording, or stop waiting for its text. */
  cancel: () => void;
}

/** A new meter bar every 60 ms: 24 bars hold the last ~1.4 s. */
const BAR_INTERVAL_MS = 60;
const DEFAULT_MAX_SECONDS = 600;

/**
 * The composer's dictation, or null where it is not offered: no project, no
 * microphone API, or a server without managed models (`available: false`).
 * One recording at a time; the words land at the caret.
 */
export function useComposerDictation({
  projectId,
  editorRef,
}: {
  projectId: string | null | undefined;
  editorRef: RefObject<ComposerEditorHandle | null>;
}): ComposerDictation | null {
  const t = useTranslations('dictation');
  const openUpgradeDialog = useUpgradeDialogStore((s) => s.openUpgradeDialog);
  const supported = typeof window !== 'undefined' && DictationRecorder.supported();
  const info = useQuery({
    queryKey: ['dictation-info', projectId],
    queryFn: () => getDictationInfo(projectId!),
    enabled: !!projectId && supported,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const [phase, setPhase] = useState<DictationPhase>('idle');
  const [levels, setLevels] = useState<number[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<DictationRecorder | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const frameRef = useRef<number | null>(null);
  const phaseRef = useRef<DictationPhase>('idle');
  const maxSeconds = info.data?.max_seconds ?? DEFAULT_MAX_SECONDS;
  const finishRef = useRef<() => void>(() => {});
  const uploadFnRef = useRef<(clip: Blob) => Promise<void>>(async () => {});

  const enter = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const stopMeter = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const insert = useCallback(
    (text: string) => {
      const editor = editorRef.current;
      if (!editor) return;
      const state = editor.getEditingState();
      const from = state?.selection.from ?? 0;
      const before = state && from > 0 ? state.doc.textBetween(from - 1, from, '\n', ' ') : '';
      const words = dictationInsert(before, text);
      if (!words) return;
      editor.insertAtCursor(words);
      editor.getElement()?.focus();
    },
    [editorRef],
  );

  const upload = useCallback(
    async (clip: Blob) => {
      if (!projectId) return;
      const controller = new AbortController();
      uploadRef.current = controller;
      enter('transcribing');
      try {
        const result = await transcribeDictation(projectId, clip, {
          surface: isDesktop() ? 'desktop' : 'web',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.text) insert(result.text);
        else infoToast(t('nothingHeard'));
      } catch (error) {
        if (controller.signal.aborted) return;
        const code = error instanceof ApiError ? error.code : undefined;
        const status = error instanceof ApiError ? error.status : undefined;
        const retry = [{ label: t('retry'), onClick: () => void uploadFnRef.current(clip) }];
        if (status === 402 && code !== 'budget_exceeded') {
          const accountId = (error as ApiError).data?.account_id;
          openUpgradeDialog({ reason: 'insufficient_credits', ...(accountId ? { accountId } : {}) });
        } else if (code === 'budget_exceeded') {
          errorToast(error instanceof Error ? error.message : t('failed'));
        } else if (code === 'dictation_unavailable') {
          errorToast(t('unavailable'));
          void info.refetch();
        } else if (status === 429 || code === 'dictation_busy') {
          errorToast(t('busy'), { actions: retry });
        } else {
          errorToast(t('failed'), { actions: retry });
        }
      } finally {
        if (uploadRef.current === controller) {
          uploadRef.current = null;
          enter('idle');
        }
      }
    },
    [projectId, enter, insert, t, openUpgradeDialog, info],
  );

  const finish = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || phaseRef.current !== 'recording') return;
    recorderRef.current = null;
    stopMeter();
    enter('transcribing');
    void recorder.stop().then((clip) => {
      if (phaseRef.current !== 'transcribing') return;
      if (clip.size === 0) {
        enter('idle');
        infoToast(t('nothingHeard'));
        return;
      }
      void upload(clip);
    });
  }, [enter, stopMeter, upload, t]);
  useEffect(() => {
    finishRef.current = finish;
    uploadFnRef.current = upload;
  }, [finish, upload]);

  const cancel = useCallback(() => {
    stopMeter();
    recorderRef.current?.cancel();
    recorderRef.current = null;
    uploadRef.current?.abort();
    uploadRef.current = null;
    enter('idle');
  }, [enter, stopMeter]);

  const start = useCallback(() => {
    if (phaseRef.current !== 'idle' || !projectId) return;
    const recorder = new DictationRecorder();
    recorderRef.current = recorder;
    enter('starting');
    setLevels([]);
    setElapsedMs(0);
    recorder
      .start()
      .then(() => {
        if (recorderRef.current !== recorder) return recorder.cancel();
        enter('recording');
        const startedAt = performance.now();
        let lastBar = 0;
        let bars: number[] = [];
        const tick = (now: number) => {
          if (recorderRef.current !== recorder) return;
          const elapsed = now - startedAt;
          if (now - lastBar >= BAR_INTERVAL_MS) {
            lastBar = now;
            bars = pushLevel(bars, recorder.level(), DICTATION_BARS);
            setLevels(bars);
            setElapsedMs(elapsed);
          }
          if (elapsed >= maxSeconds * 1000) {
            infoToast(t('limitReached', { minutes: Math.round(maxSeconds / 60) }));
            finishRef.current();
            return;
          }
          frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
      })
      .catch((error: unknown) => {
        recorderRef.current = null;
        enter('idle');
        const problem = error instanceof MicrophoneError ? error.problem : 'unsupported';
        errorToast(
          problem === 'denied'
            ? t(isDesktop() ? 'micDeniedDesktop' : 'micDenied')
            : problem === 'missing'
              ? t('micMissing')
              : problem === 'busy'
                ? t('micBusy')
                : t('micUnsupported'),
        );
      });
  }, [projectId, enter, maxSeconds, t]);

  // Escape drops the take while one runs, before the composer reads Escape as Stop.
  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase, cancel]);

  // A composer that unmounts mid-take releases the microphone.
  useEffect(() => () => cancel(), [cancel]);

  if (!supported || !projectId || !info.data?.available) return null;
  return {
    phase,
    levels,
    elapsedMs,
    maxSeconds,
    creditsPerMinute: info.data.credits_per_minute,
    start,
    finish,
    cancel,
  };
}
