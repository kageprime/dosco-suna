import { backendApi } from "../../http/api-client";
import type { NativeFilePart } from "../../files/client";
import { unwrap } from "./shared";

/** Whether a workspace can dictate, and what a minute of audio costs. */
export interface DictationInfo {
  /** False on a server that serves no managed models (a self-host without Platinum). */
  available: boolean;
  /** Credits per minute of audio, billed per second. 1 credit = $0.01. */
  credits_per_minute: number;
  /** The longest clip a composer should record. */
  max_seconds: number;
  max_bytes: number;
}

/** The text of one dictated clip and what it cost. */
export interface DictationTranscript {
  /** The words heard, trimmed. Empty when the clip held no speech (still charged by its length). */
  text: string;
  /** The billed audio duration. */
  seconds: number;
  /** Credits charged for the clip. */
  credits: number;
}

/** The client that recorded a clip, for product analytics. */
export type DictationSurface = "web" | "desktop" | "mobile" | "other";

export interface TranscribeDictationOptions {
  surface?: DictationSurface;
  signal?: AbortSignal;
}

const EXTENSIONS: Array<[RegExp, string]> = [
  [/^audio\/webm\b/, "webm"],
  [/^audio\/(mp4|m4a|x-m4a|aac)\b/, "m4a"],
  [/^audio\/ogg\b/, "ogg"],
  [/^audio\/(wav|x-wav|wave)\b/, "wav"],
  [/^audio\/(mpeg|mp3)\b/, "mp3"],
];

/** The file name a clip of this MIME type is sent as (`dictation.webm` when unknown). */
export function dictationFileName(mime: string): string {
  const type = mime.trim().toLowerCase();
  const ext = EXTENSIONS.find(([pattern]) => pattern.test(type))?.[1] ?? "webm";
  return `dictation.${ext}`;
}

/** `GET /workspaces/:id/dictation`: availability, price and clip limits. */
export async function getDictationInfo(projectId: string): Promise<DictationInfo> {
  return unwrap(
    await backendApi.get<DictationInfo>(`/workspaces/${encodeURIComponent(projectId)}/dictation`, {
      showErrors: false,
    }),
  );
}

/**
 * Transcribe one recorded clip (`POST /workspaces/:id/dictation`) and charge
 * the workspace credits for it. Takes a `Blob` (web, desktop) or, on React
 * Native, a device file by `uri`. A refusal throws `ApiError` with the
 * server's `code`: `insufficient_credits` (402), `budget_exceeded` (402),
 * `dictation_unavailable` / `dictation_busy` / `dictation_failed` (503),
 * `rate_limit_exceeded` (429), `unsupported_audio` (415), `empty_audio` (400).
 */
export async function transcribeDictation(
  projectId: string,
  audio: Blob | NativeFilePart,
  options: TranscribeDictationOptions = {},
): Promise<DictationTranscript> {
  const form = new FormData();
  if (audio instanceof Blob) {
    form.append("audio", audio, dictationFileName(audio.type));
  } else {
    // React Native's FormData streams a device file from its uri.
    form.append("audio", {
      uri: audio.uri,
      name: audio.name,
      type: audio.type || "audio/mp4",
    } as unknown as Blob);
  }
  if (options.surface) form.append("surface", options.surface);
  return unwrap(
    await backendApi.upload<DictationTranscript>(
      `/workspaces/${encodeURIComponent(projectId)}/dictation`,
      form,
      { signal: options.signal, timeout: 120_000, showErrors: false },
    ),
  );
}
