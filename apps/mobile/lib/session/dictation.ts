/**
 * Dictation — pure rules for the composer's voice input.
 *
 * The composer records the microphone (expo-audio) while the user talks. Done
 * uploads the clip to Kortix (`transcribeDictation` in `@kortix/sdk`), which
 * transcribes it and bills the workspace credits per minute. The text lands
 * after what was typed.
 */

/** Bars in the listening waveform, newest on the right. */
export const DICTATION_BAR_COUNT = 28;

/** The longest clip, in seconds, when the server does not say (GET …/dictation `max_seconds`). */
export const DICTATION_MAX_SECONDS = 600;

/** The composer text after dictation: what was typed before, then the words. */
export function dictationDraft(base: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return base;
  if (!base || /\s$/.test(base)) return base + words;
  return `${base} ${words}`;
}

/** Below this the microphone hears the room, not a voice (dBFS). */
const METERING_FLOOR_DB = -55;
/** At or above this a voice is at full height (dBFS). */
const METERING_CEILING_DB = -10;

/**
 * A waveform bar height (0–1) from the recorder's metering in dBFS: iOS
 * `averagePower` and Android's max amplitude both report −160 (silence) to 0.
 * The square root lifts quiet speech so the bars move for a normal voice.
 */
export function levelFromMetering(dbfs: number | null | undefined): number {
  if (typeof dbfs !== 'number' || !Number.isFinite(dbfs)) return 0;
  const t = (dbfs - METERING_FLOOR_DB) / (METERING_CEILING_DB - METERING_FLOOR_DB);
  if (t <= 0) return 0;
  return Math.sqrt(Math.min(t, 1));
}

export function pushLevel(history: readonly number[], level: number): number[] {
  const next = [...history, level];
  return next.length > DICTATION_BAR_COUNT ? next.slice(next.length - DICTATION_BAR_COUNT) : next;
}

export interface DictationFailure {
  message: string;
  /** The same clip may succeed if sent again: the toast offers Retry and the clip is kept. */
  retry: boolean;
  /** The failure is the wallet: the toast offers Billing. */
  billing?: boolean;
}

/**
 * The toast for a failed transcription, or null when nothing went wrong from
 * the user's view (they cancelled). Reads the SDK `ApiError` fields by shape.
 */
export function dictationFailure(error: unknown): DictationFailure | null {
  const e = (error ?? {}) as { name?: unknown; status?: unknown; code?: unknown };
  if (e.name === 'AbortError') return null;
  const status = typeof e.status === 'number' ? e.status : 0;
  const code = typeof e.code === 'string' ? e.code : '';
  if (status === 402 || code === 'insufficient_credits' || code === 'budget_exceeded') {
    return code === 'budget_exceeded'
      ? { message: "This workspace reached its spending limit. Dictation is paused until it resets.", retry: false }
      : { message: 'Out of credits. Top up to keep dictating.', retry: false, billing: true };
  }
  if (status === 429 || code === 'dictation_busy') {
    return { message: 'Dictation is busy. Try again in a moment.', retry: true };
  }
  if (code === 'dictation_unavailable') {
    return { message: 'Dictation is not available on this server.', retry: false };
  }
  if (status === 413 || code === 'audio_too_large') {
    return { message: 'The recording is too long to transcribe.', retry: false };
  }
  if (status === 400 || status === 415) {
    return { message: "Couldn't read the recording. Try dictating again.", retry: false };
export function dictationErrorMessage(code: string): string | null {
  switch (code) {
    case 'aborted':
    case 'no-speech':
    case 'speech-timeout':
      return null;
    case 'not-allowed':
      return 'Allow microphone and speech recognition for Dosco in Settings.';
    case 'network':
      return 'Dictation needs a connection. Check your network and try again.';
    case 'language-not-supported':
      return 'Dictation does not support your language on this device.';
    case 'service-not-allowed':
      return 'Speech recognition is turned off on this device.';
    case 'busy':
      return 'The microphone is in use by another app.';
    case 'interrupted':
      return 'Dictation stopped because another app took the microphone.';
    default:
      return 'Dictation stopped. Try again.';

  }
  return { message: 'Dictation failed. Check your connection and try again.', retry: true };
}
