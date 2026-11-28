import type {
  AuthedPrincipal,
  TokenCounts,
  UpstreamDescriptor,
} from '../domain';
import {
  type ExtractedUsage,
  type SseErrorFrame,
  estimateOutputTokens,
} from '../usage';
import { calculateCost } from '../usage/pricing';
import {
  type DispatchOutcome,
} from './dispatch';
import {
  publicUpstreamError,
  shownModel,
  shownProvider,
} from './public-identity';
import { type StreamObservation } from './streaming';
import { createTraceEmitter } from './trace';

import type { HandlerRuntime } from './chat-shared';
import { EMPTY_USAGE, identity, streamErrorTraceStatus } from './chat-shared';
interface SettlementInput {
  hooks: HandlerRuntime['hooks'];
  logger: HandlerRuntime['logger'];
  id: string;
  emit: ReturnType<typeof createTraceEmitter>;
  principal: AuthedPrincipal;
  requestedModel: string;
  routedModel: string;
  routeModel: string;
  streaming: boolean;
  promptTokenEstimate: number;
  cachedTokenEstimate: number;
  upstream: Response;
  attemptFailures: DispatchOutcome['attemptFailures'];
}
interface SettlementState {
  served: UpstreamDescriptor;
  attempts: number;
  candidatesTried: string[];
  publicFailure: { status: number; code: string; message: string } | null;
}
export function createSettlement(input: SettlementInput, current: () => SettlementState) {
  const { hooks, logger, id, emit, principal, requestedModel, routedModel, routeModel, streaming, promptTokenEstimate, cachedTokenEstimate, upstream, attemptFailures } = input;
  // Gateway-authored stream endings; their text names no upstream.
  const GATEWAY_STREAM_CODES = new Set([
    'client_aborted',
    'upstream_inactivity_timeout',
    // Gateway-authored: the message names no provider ("upstream stream ended
    // without a finish_reason or [DONE]" / "upstream stream error"), so it
    // never needs `publicUpstreamError`'s status/message classification.
    'upstream_incomplete_stream',
  ]);
  const publicStreamError = (streamError: SseErrorFrame): SseErrorFrame => {
    if (GATEWAY_STREAM_CODES.has(String(streamError.code))) return streamError;
    const code = Number(streamError.code);
    const classified = publicUpstreamError(Number.isFinite(code) ? code : 0, streamError.message ?? '', routedModel);
    return { message: classified.message, code: classified.code };
  };
  return async (
    reported: ExtractedUsage | null,
    streamError: SseErrorFrame | null = null,
    observed?: StreamObservation,
  ): Promise<void> => {
    const { served, attempts, candidatesTried, publicFailure } = current();
    // A stream that ended without the provider's usage frame still consumed
    // the prompt and every streamed token. Settle an estimate when the client
    // stopped it, or when output was already served; a provider failure
    // before any output served nothing and settles as zero.
    const estimated =
      !reported &&
      !!observed &&
      served.billingMode !== 'none' &&
      (observed.clientStopped || observed.outputChars > 0);
    const usage: ExtractedUsage | null = estimated
      ? {
          promptTokens: promptTokenEstimate,
          completionTokens: estimateOutputTokens(observed!.outputChars),
          cachedTokens: cachedTokenEstimate,
          cacheWriteTokens: 0,
        }
      : reported;
    if (estimated) {
      logger.warn(
        `[gateway] ${id}: stream ended without a usage frame (${streamError?.code ?? 'no error'}); settling an estimate of ${usage!.promptTokens} prompt + ${usage!.completionTokens} output tokens`,
      );
    }
    if (streamError?.code === 'upstream_incomplete_stream') {
      // The upstream ended without a finish_reason/[DONE]/error frame — see
      // relayStream's `handleIncompleteTermination`. Log it as its own,
      // greppable line (provider/model/endpoint/bytes/tokens/duration —
      // never prompt content) so a cluster of cuts on one endpoint is
      // visible, and count it toward the same pool cooldown a 429 uses — a
      // pooled key/endpoint that keeps truncating streams gets rotated away
      // from too, not just rate-limited ones. The cooldown is short: an
      // incomplete stream is not proof the key is dead, only unreliable now.
      const detail = streamError.detail as
        | { bytesForwarded?: number; durationMs?: number; redispatchAttempts?: number; reason?: unknown }
        | undefined;
      logger.warn(`[gateway] ${id}: incomplete upstream stream`, {
        requestId: id,
        provider: served.provider,
        model: served.resolvedModel ?? routedModel,
        endpoint: served.baseUrl,
        bytesForwarded: detail?.bytesForwarded ?? 0,
        outputChars: observed?.outputChars ?? 0,
        durationMs: detail?.durationMs,
        redispatchAttempts: detail?.redispatchAttempts ?? 0,
        underlyingReason: detail?.reason,
      });
      if (served.poolSecretId && hooks.notePoolRateLimit) {
        try {
          await hooks.notePoolRateLimit(principal, served.poolSecretId, 10);
        } catch (error) {
          logger.error('[gateway] could not record stream-cut cooldown', {
            secretId: served.poolSecretId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    const counts: TokenCounts = usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cachedTokens: usage.cachedTokens,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        }
      : EMPTY_USAGE;
    const { upstreamCost, finalCost } = calculateCost(
      served.resolvedModel ?? routedModel,
      counts,
      served.billingMode === 'none' ? 0 : served.markup,
      usage?.upstreamCostHint,
      served.pricing,
    );
    if (counts.promptTokens + counts.completionTokens > 0 || principal.billingHold) {
      await hooks.recordUsage({
        ...counts,
        accountId: principal.accountId,
        actorUserId: principal.userId,
        projectId: principal.projectId,
        sessionId: principal.sessionId,
        provider: shownProvider(served),
        model: shownModel(served, routedModel),
        ...(served.publicProvider
          ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
          : {}),
        upstreamCost,
        finalCost,
        billingMode: served.billingMode,
        streaming,
        requestId: id,
        ...(principal.billingHold ? { billingHoldUsd: principal.billingHold.amountUsd } : {}),
        ...(estimated ? { usageEstimated: true } : {}),
      });
    }
    const shownStreamError =
      streamError && served.publicProvider ? publicStreamError(streamError) : streamError;
    emit({
      ...identity(principal),
      requestedModel,
      resolvedModel: shownModel(served, routedModel),
      provider: shownProvider(served),
      ...(served.publicProvider
        ? { upstream: { provider: served.provider, model: served.resolvedModel ?? routedModel } }
        : {}),
      billingMode: served.billingMode,
      streaming,
      status: publicFailure?.status ?? (streamError ? streamErrorTraceStatus(streamError) : upstream.status),
      ok: !streamError && upstream.ok,
      errorCode:
        publicFailure?.code ??
        (shownStreamError ? String(shownStreamError.code ?? 'upstream_stream_error') : undefined),
      errorMessage: publicFailure?.message ?? shownStreamError?.message,
      attempts,
      candidatesTried,
      attemptFailures,
      servedModel: routedModel,
      ...(routedModel !== routeModel ? { fallbackFrom: routeModel } : {}),
      metadata: { usageEstimated: estimated || !reported },
      usage: counts,
      upstreamCost,
      finalCost,
    });
  };
}
