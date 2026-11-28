/**
 * useDictation — the composer's voice input, transcribed by Kortix.
 *
 * - `start()` asks for the microphone once, then records an m4a clip
 *   (expo-audio). The waveform reads the recorder's metering on a timer into a
 *   shared value, so the composer never re-renders per sample.
 * - `finish()` stops, uploads the clip (`transcribeDictation`, billed 1 credit
 *   per minute from the workspace credits) and writes the text after what was
 *   typed (`dictationDraft`). The clip stays on disk until the upload
 *   succeeds: a retryable failure offers Retry with the same clip.
 * - `cancel()` drops the clip; nothing is uploaded or charged.
 * - Recording stops by itself at the server's `max_seconds` and is uploaded.
 *
 * `available` is true only when the server says it serves dictation for the
 * project (`getDictationInfo`): a self-host without managed models, or an API
 * older than the route, hides the mic.
 */
import * as React from 'react';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import * as FileSystem from 'expo-file-system/legacy';
import {
  AudioQuality,
  IOSOutputFormat,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  type RecordingOptions,
} from 'expo-audio';
import { useQuery } from '@tanstack/react-query';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { getDictationInfo, transcribeDictation } from '@kortix/sdk';

import { useToast } from '@/components/kortix/toast-provider';
import { haptics } from '@/lib/haptics';
import { log } from '@/lib/logger';
import {
  DICTATION_BAR_COUNT,
  DICTATION_MAX_SECONDS,
  dictationDraft,
  dictationFailure,
  levelFromMetering,
  pushLevel,
} from '@/lib/session/dictation';
import { resetAudioMode } from '@/lib/sounds';

/** One waveform bar per sample. */
const METER_INTERVAL_MS = 80;

/** Mono AAC in an m4a: ~480 KB a minute, well under the 25 MB clip cap at 10 minutes. */
const RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 44100,
  numberOfChannels: 1,
  bitRate: 64000,
  isMeteringEnabled: true,
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.HIGH,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: { mimeType: 'audio/webm', bitsPerSecond: 64000 },
};

export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping';

const SILENT_LEVELS = Array.from({ length: DICTATION_BAR_COUNT }, () => 0);

export const dictationInfoKey = (projectId: string) => ['dictation-info', projectId] as const;

export interface Dictation {
  /** The server serves dictation for this project: the composer shows the mic. */
  available: boolean;
  state: DictationState;
  /** `state !== 'idle'`: the control row shows the listening bar. */
  active: boolean;
  levels: SharedValue<number[]>;
  start: () => void;
  finish: () => void;
  cancel: () => void;
}

function removeClip(uri: string | null | undefined) {
  if (!uri) return;
  FileSystem.deleteAsync(uri, { idempotent: true }).catch((error) =>
    log.warn('[dictation] could not delete the clip', error)
  );
}

/** Leave the record category, so the next sound plays through the speaker again. */
function endRecordingAudioMode() {
  setAudioModeAsync({ allowsRecording: false }).catch(() => {});
  resetAudioMode();
}

export function useDictation({
  value,
  onChangeText,
  projectId,
}: {
  value: string;
  onChangeText: (text: string) => void;
  /** The workspace the words are billed to. Without one there is no mic. */
  projectId?: string;
}): Dictation {
  const toast = useToast();
  const recorder = useAudioRecorder(RECORDING);
  const [state, setState] = React.useState<DictationState>('idle');
  const levels = useSharedValue<number[]>(SILENT_LEVELS);

  const info = useQuery({
    queryKey: dictationInfoKey(projectId ?? ''),
    queryFn: () => getDictationInfo(projectId!),
    enabled: !!projectId,
    // The price and availability change with a deploy, not per visit.
    staleTime: 10 * 60_000,
    retry: false,
  });
  const maxSeconds = info.data?.max_seconds ?? DICTATION_MAX_SECONDS;

  // The session reads the latest props without restarting on every keystroke.
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onChangeRef = React.useRef(onChangeText);
  onChangeRef.current = onChangeText;
  const projectRef = React.useRef(projectId);
  projectRef.current = projectId;

  const session = React.useRef<{
    meter: ReturnType<typeof setInterval> | null;
    upload: AbortController | null;
    /** The recorded clip, kept until its upload succeeds or the user cancels. */
    uri: string | null;
  } | null>(null);

  const teardown = React.useCallback(() => {
    const s = session.current;
    if (!s) return;
    if (s.meter) clearInterval(s.meter);
    session.current = null;
    levels.value = SILENT_LEVELS;
    setState('idle');
  }, [levels]);

  const upload = React.useCallback(
    async (uri: string) => {
      const pid = projectRef.current;
      const s = session.current ?? { meter: null, upload: null, uri };
      session.current = s;
      s.uri = uri;
      if (!pid) {
        teardown();
        return;
      }
      setState('stopping');
      const abort = new AbortController();
      s.upload = abort;
      try {
        const result = await transcribeDictation(
          pid,
          { uri, name: 'dictation.m4a', type: 'audio/mp4' },
          { surface: 'mobile', signal: abort.signal }
        );
        if (session.current !== s) return; // cancelled meanwhile
        removeClip(uri);
        teardown();
        if (result.text) {
          haptics.success();
          onChangeRef.current(dictationDraft(valueRef.current, result.text));
        } else {
          toast.info("Didn't catch that.");
        }
      } catch (error) {
        if (session.current !== s) return;
        teardown();
        const failure = dictationFailure(error);
        if (!failure) {
          removeClip(uri);
          return;
        }
        log.warn('[dictation] transcription failed', error);
        haptics.error();
        if (failure.retry) {
          toast.error(failure.message, { action: { label: 'Retry', onPress: () => void upload(uri) } });
        } else {
          removeClip(uri);
          toast.error(
            failure.message,
            failure.billing ? { action: { label: 'Billing', onPress: () => router.push('/billing') } } : undefined
          );
        }
      }
    },
    [teardown, toast]
  );

  const finish = React.useCallback(async () => {
    const s = session.current;
    if (!s || s.upload || !s.meter) return;
    haptics.selection();
    clearInterval(s.meter);
    s.meter = null;
    setState('stopping');
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri ?? recorder.getStatus().url;
    } catch (error) {
      log.warn('[dictation] stop failed', error);
    }
    endRecordingAudioMode();
    if (session.current !== s) {
      removeClip(uri); // cancelled while stopping
      return;
    }
    if (!uri) {
      teardown();
      toast.error('Dictation stopped. Try again.');
      return;
    }
    await upload(uri);
  }, [recorder, teardown, toast, upload]);

  const start = React.useCallback(async () => {
    if (session.current || !projectRef.current) return;
    haptics.tap();
    const s = { meter: null as ReturnType<typeof setInterval> | null, upload: null, uri: null };
    session.current = s;
    setState('starting');

    let granted = false;
    try {
      let permission = await getRecordingPermissionsAsync();
      if (!permission.granted && permission.canAskAgain) permission = await requestRecordingPermissionsAsync();
      granted = permission.granted;
    } catch (error) {
      log.warn('[dictation] permission check failed', error);
    }
    if (session.current !== s) return; // cancelled while the prompt was up
    if (!granted) {
      teardown();
      toast.error('Dosco cannot use the microphone', {
        description: 'Allow microphone and speech recognition in Settings.',

        action: { label: 'Settings', onPress: () => void Linking.openSettings() },
      });
      return;
    }

    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (session.current !== s) {
        endRecordingAudioMode();
        return;
      }
      recorder.record();
    } catch (error) {
      log.warn('[dictation] recording failed to start', error);
      endRecordingAudioMode();
      teardown();
      toast.error('The microphone is in use by another app.');
      return;
    }
    setState('listening');
    s.meter = setInterval(() => {
      if (session.current !== s) return;
      const status = recorder.getStatus();
      levels.value = pushLevel(levels.value, levelFromMetering(status.metering));
      if (status.durationMillis >= maxSeconds * 1000) void finish();
    }, METER_INTERVAL_MS);
  }, [finish, levels, maxSeconds, recorder, teardown, toast]);

  const cancel = React.useCallback(() => {
    const s = session.current;
    if (!s) return;
    haptics.selection();
    s.upload?.abort();
    const recording = !!s.meter;
    teardown();
    if (recording) {
      recorder
        .stop()
        .then(() => removeClip(recorder.uri))
        .catch(() => {})
        .finally(endRecordingAudioMode);
    } else {
      removeClip(s.uri);
    }
  }, [recorder, teardown]);

  // Leaving the screen mid-dictation stops the microphone and drops the clip.
  React.useEffect(
    () => () => {
      const s = session.current;
      if (!s) return;
      s.upload?.abort();
      if (s.meter) {
        clearInterval(s.meter);
        // The recorder may already be released with the screen.
        try {
          void recorder.stop().catch(() => {});
        } catch {
          // released
        }
        endRecordingAudioMode();
      }
      session.current = null;
    },
    [recorder]
  );

  return {
    available: !!projectId && info.data?.available === true,
    state,
    active: state !== 'idle',
    levels,
    start: () => void start(),
    finish: () => void finish(),
    cancel,
  };
}
