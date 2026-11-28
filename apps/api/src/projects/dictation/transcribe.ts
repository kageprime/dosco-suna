/**
 * Composer dictation: a recorded clip in, its text out, billed from the
 * account's credits at a flat price per minute (`dictationPriceUsd`).
 *
 * Platinum Inference serves the model, the same managed Whisper the gateway's
 * `/audio/transcriptions` serves. This path does not go through the gateway
 * process: the gateway prices audio at the upstream's reported cost × markup
 * and refuses the Free plan (no managed models), and dictation is neither.
 * The charge still lands through the gateway's own settlement
 * (`recordGatewayUsage`): one usage row attributed to the project and person,
 * one ledger row ("Dictation") keyed on that row, project budgets respected.
 *
 * Audio and text are never stored or logged: only sizes, seconds and status.
 */
import { config } from '../../config';
import { logger } from '../../lib/logger';
import { checkBillingAdmission } from '../../billing/services/billing-gate';
import { dictationPriceUsd } from '../../billing/services/tiers';
import {
  assertGatewayBudget,
  GatewayBudgetExceededError,
  persistGatewayTrace,
  recordGatewayUsage,
} from '../../llm-gateway/hooks';
import { releaseBudgetReservation } from '../../llm-gateway/budgets';

/** The managed Whisper (Platinum Inference `/audio/transcriptions`). */
export const DICTATION_MODEL = 'whisper-large-v3-turbo';
/** One clip. The composer stops recording at the time cap; the byte cap is the upstream's file limit. */
export const DICTATION_MAX_SECONDS = 600;
export const DICTATION_MAX_BYTES = 25 * 1024 * 1024;
/** The upstream transcribes 10 minutes in a few seconds; this bounds only a hung connection. */
const UPSTREAM_TIMEOUT_MS = 90_000;

/**
 * The containers Whisper reads, by extension, with the MIME type each is sent
 * upstream as. The type a client declares does not survive Bun's multipart
 * parser (Bun 1.4.3 re-derives it from the file name: `clip.webm` +
 * `audio/webm` arrives as `video/webm`, a name with no extension as ""), so a
 * clip is identified by its first bytes, then by its name.
 */
const CONTAINERS: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};
const NAME_EXTENSIONS: Record<string, string> = {
  webm: 'webm', ogg: 'ogg', oga: 'ogg', opus: 'ogg', m4a: 'm4a', mp4: 'm4a', mp3: 'mp3', mpga: 'mp3', mpeg: 'mp3', wav: 'wav', flac: 'flac',
};

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length && [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

/** The container in a clip's first bytes (its magic number), or null. */
function sniffContainer(head: Uint8Array): string | null {
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (ascii(head, 0, 'OggS')) return 'ogg';
  if (ascii(head, 4, 'ftyp')) return 'm4a';
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'wav';
  if (ascii(head, 0, 'fLaC')) return 'flac';
  if (ascii(head, 0, 'ID3') || (head.length >= 2 && head[0] === 0xff && (head[1]! & 0xe0) === 0xe0)) return 'mp3';
  return null;
}

/**
 * The container Whisper reads a clip as (`webm`, `ogg`, `m4a`, `mp3`, `wav`,
 * `flac`), from its first bytes or else its file name; null for anything else.
 */
export function dictationAudioExtension(head: Uint8Array, fileName = ''): string | null {
  const sniffed = sniffContainer(head);
  if (sniffed) return sniffed;
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return NAME_EXTENSIONS[ext] ?? null;
}

export interface DictationScope {
  accountId: string;
  projectId: string;
  userId: string;
}

export interface DictationBillingRefusal {
  balance: number;
  hasSubscription: boolean;
  billingState: string;
}

export type DictationResult =
  | { ok: true; text: string; seconds: number; costUsd: number; latencyMs: number }
  | {
      ok: false;
      status: 400 | 402 | 413 | 415 | 503;
      code: string;
      message: string;
      billing?: DictationBillingRefusal;
      retryAfterSeconds?: number;
    };

/** Dictation runs where Kortix serves managed models (not on a self-host without Platinum). */
export function dictationAvailable(): boolean {
  return Boolean(config.KORTIX_MANAGED_PROVIDER_ENABLED && config.PLATINUM_INFERENCE_API_KEY);
}

function refusal(
  status: 400 | 402 | 413 | 415 | 503,
  code: string,
  message: string,
  extra: { billing?: DictationBillingRefusal; retryAfterSeconds?: number } = {},
): DictationResult {
  return { ok: false, status, code, message, ...extra };
}

type UpstreamAnswer =
  | { ok: true; text: string; seconds: number; upstreamCostUsd: number }
  | { ok: false; busy: boolean };

async function callWhisper(audio: Blob, extension: string, requestId: string, signal?: AbortSignal): Promise<UpstreamAnswer> {
  const form = new FormData();
  form.append('file', new File([audio], `dictation.${extension}`, { type: CONTAINERS[extension] }));
  form.append('model', DICTATION_MODEL);
  form.append('response_format', 'json');
  const timeout = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
  const base = config.PLATINUM_INFERENCE_URL.replace(/\/+$/, '');
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.PLATINUM_INFERENCE_API_KEY}`, 'x-request-id': requestId },
    body: form,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.warn('[dictation] upstream refused', { requestId, status: response.status, detail: detail.slice(0, 300) });
    return { ok: false, busy: response.status === 429 };
  }
  const body = (await response.json().catch(() => null)) as
    | { text?: unknown; usage?: { seconds?: unknown; cost?: unknown } }
    | null;
  const seconds = Number(body?.usage?.seconds);
  if (!body || !Number.isFinite(seconds) || seconds < 0) {
    // No billed duration: the answer cannot be priced, so it is not delivered for free.
    logger.error('[dictation] upstream answered without a billed duration', { requestId });
    return { ok: false, busy: false };
  }
  const cost = Number(body.usage?.cost);
  return {
    ok: true,
    text: typeof body.text === 'string' ? body.text.trim() : '',
    seconds,
    upstreamCostUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
  };
}

/**
 * Transcribe one clip for a person in a project and charge the account.
 * The caller has already checked that the person may start sessions there.
 */
export async function transcribeDictation(
  scope: DictationScope,
  audio: Blob,
  signal?: AbortSignal,
): Promise<DictationResult> {
  // The request is checked before the server: a malformed clip is the
  // client's to fix on every deployment.
  // An empty part loses its type in transit: empty is checked first.
  if (audio.size === 0) return refusal(400, 'empty_audio', 'The recording is empty.');
  const head = new Uint8Array(await audio.slice(0, 16).arrayBuffer());
  const extension = dictationAudioExtension(head, audio instanceof File ? audio.name : '');
  if (!extension) {
    return refusal(415, 'unsupported_audio', 'Send a WebM, Ogg, MP4/M4A, MP3, WAV or FLAC recording.');
  }
  if (audio.size > DICTATION_MAX_BYTES) return refusal(413, 'audio_too_large', 'The recording is larger than 25 MB.');
  if (!dictationAvailable()) {
    return refusal(503, 'dictation_unavailable', 'Dictation is not available on this server.');
  }

  const { accountId, projectId, userId } = scope;
  // A blocking project budget reserves here; recordGatewayUsage (or the
  // release below) returns the reservation.
  try {
    await assertGatewayBudget({ accountId, projectId, userId });
  } catch (error) {
    if (error instanceof GatewayBudgetExceededError) return refusal(402, 'budget_exceeded', error.message);
    throw error;
  }
  const release = () => releaseBudgetReservation(projectId, userId);

  let billing: Awaited<ReturnType<typeof checkBillingAdmission>>;
  try {
    billing = await checkBillingAdmission(accountId);
  } catch (error) {
    release();
    throw error;
  }
  if (!billing.ok) {
    release();
    return refusal(402, billing.reason, billing.message, {
      billing: { balance: billing.balance, hasSubscription: billing.hasSubscription, billingState: billing.billingState },
    });
  }

  const requestId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  /**
   * The request-log row: what project budgets sum (`gateway_request_logs`,
   * rolled into `gateway_spend_daily`) and what the gateway Logs tab lists.
   * It carries sizes, seconds and cost: never the audio, never the words.
   */
  const trace = (result: {
    status: number;
    ok: boolean;
    errorCode?: string;
    errorMessage?: string;
    seconds?: number;
    upstreamCost?: number;
    finalCost?: number;
  }) =>
    persistGatewayTrace({
      requestId,
      startedAt,
      accountId,
      actorUserId: userId,
      projectId,
      requestedModel: 'dictation',
      resolvedModel: 'dictation',
      provider: 'kortix',
      upstream: { provider: 'platinum', model: DICTATION_MODEL },
      billingMode: 'credits',
      streaming: false,
      status: result.status,
      ok: result.ok,
      ...(result.errorCode ? { errorCode: result.errorCode, errorMessage: result.errorMessage } : {}),
      latencyMs: Math.round(performance.now() - started),
      attempts: 1,
      candidatesTried: ['kortix:dictation'],
      usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 },
      upstreamCost: result.upstreamCost ?? 0,
      finalCost: result.finalCost ?? 0,
      request: { model: 'dictation', container: extension, bytes: audio.size },
      response: result.seconds === undefined ? null : { seconds: result.seconds },
      metadata: { surface: 'dictation' },
    }).catch((error: unknown) =>
      logger.error('[dictation] request trace was not recorded', {
        requestId,
        projectId,
        finalCost: result.finalCost ?? 0,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      }),
    );

  let answer: UpstreamAnswer;
  try {
    answer = await callWhisper(audio, extension, requestId, signal);
  } catch (error) {
    release();
    logger.warn('[dictation] upstream unreachable', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    await trace({ status: 503, ok: false, errorCode: 'dictation_failed', errorMessage: 'The transcription upstream did not answer.' });
    return refusal(503, 'dictation_failed', 'Transcription failed. Try again.');
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!answer.ok) {
    release();
    const code = answer.busy ? 'dictation_busy' : 'dictation_failed';
    await trace({ status: 503, ok: false, errorCode: code, errorMessage: 'The transcription upstream refused the clip.' });
    return answer.busy
      ? refusal(503, 'dictation_busy', 'Transcription is busy right now. Try again in a few seconds.', { retryAfterSeconds: 5 })
      : refusal(503, 'dictation_failed', 'Transcription failed. Try again.');
  }

  // Every clip is charged by its seconds, words or not: Kortix pays the
  // upstream for silence too, and a free silent clip has no length cap.
  const costUsd = dictationPriceUsd(answer.seconds);
  await trace({
    status: 200,
    ok: true,
    seconds: answer.seconds,
    upstreamCost: answer.upstreamCostUsd,
    finalCost: costUsd,
  });
  try {
    await recordGatewayUsage({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      accountId,
      actorUserId: userId,
      projectId,
      provider: 'kortix',
      model: 'dictation',
      upstream: { provider: 'platinum', model: DICTATION_MODEL },
      upstreamCost: answer.upstreamCostUsd,
      finalCost: costUsd,
      billingMode: 'credits',
      streaming: false,
      requestId,
      operation: 'audio.dictation',
    });
  } catch (error) {
    // The words are the person's work: they are returned even when the charge
    // could not be written. The log carries what to reconcile.
    logger.error('[dictation] usage was not recorded', {
      requestId,
      accountId,
      projectId,
      seconds: answer.seconds,
      costUsd,
      error: error instanceof Error ? error.message.split('\n')[0] : String(error),
    });
  }
  logger.info('[dictation] transcribed', { requestId, projectId, seconds: answer.seconds, bytes: audio.size, latencyMs, empty: !answer.text });
  return { ok: true, text: answer.text, seconds: answer.seconds, costUsd, latencyMs };
}
