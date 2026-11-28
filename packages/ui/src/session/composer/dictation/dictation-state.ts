/**
 * Dictation — pure rules for the composer's microphone (web and desktop).
 * The recorder (`recorder.ts`) and the hook (`use-composer-dictation.ts`) hold
 * the browser state; everything here is a value in, a value out.
 */

/** Bars in the live level meter, newest on the right. */
export const DICTATION_BARS = 24;

/**
 * The containers a browser may record, best first. Chrome, Edge, Firefox and
 * Electron take WebM/Opus; Safari takes MP4/AAC. Whisper reads all of them.
 */
const RECORDING_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/** The MIME type to record, or '' to let the browser choose. */
export function pickRecordingType(isTypeSupported: (type: string) => boolean): string {
  return RECORDING_TYPES.find((type) => {
    try {
      return isTypeSupported(type);
    } catch {
      return false;
    }
  }) ?? '';
}

/**
 * A meter level (0..1) from the RMS of the last samples. Speech sits between
 * about -45 and -10 dBFS; -60 dBFS and below is silence.
 */
export function levelFromRms(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 50));
}

export function pushLevel(history: readonly number[], level: number, bars = DICTATION_BARS): number[] {
  const next = [...history, level];
  return next.length > bars ? next.slice(next.length - bars) : next;
}

/** `m:ss` for the recording timer: `0:07`, `1:05`, `10:00`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The text to insert after `before` (the character left of the caret, or '').
 * A word right before the caret gets a space; punctuation that opens the
 * transcript joins it as written.
 */
export function dictationInsert(before: string, text: string): string {
  const words = text.trim();
  if (!words) return '';
  if (!before || /\s/.test(before) || /^[,.;:!?)]/.test(words)) return words;
  return ` ${words}`;
}

/** What went wrong with the microphone, from a `getUserMedia` refusal. */
export type MicrophoneProblem = 'denied' | 'missing' | 'busy' | 'unsupported';

export function microphoneProblem(error: unknown): MicrophoneProblem {
  const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'missing';
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return 'busy';
  return 'unsupported';
}
