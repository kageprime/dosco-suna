import type { SandboxProviderName } from '../config';
import { isProviderIngressAuthFailure } from '../sandbox-proxy/provider-auth';
import { appProviderStoppedResponse } from './public-proxy-status';

/**
 * Fetch an App upstream and heal the two provider-runtime failures that have a
 * deterministic retry: a thrown connect (wake and retry), a dead-runtime 400/5xx
 * (force a provider start and retry), and a rotated provider ingress credential
 * (drop the provider's cached handle and retry a replayable request once).
 *
 * Kept separate from the handler so its retry policy is testable without a
 * database or an App runtime.
 */
export async function fetchWithRecovery(
  fetchUpstream: () => Promise<Response>,
  recoverProviderRuntime: (force: boolean) => Promise<void>,
  startingResponse: () => Promise<Response>,
  provider: () => SandboxProviderName,
  invalidateIngress: () => void,
  replayableRequest: boolean,
  coldStart: boolean,
): Promise<{ upstream: Response; recoveredProvider: boolean; starting?: never } | { starting: Response; upstream?: never; recoveredProvider?: never }> {
  let upstream: Response;
  let recoveredProvider = false;
  try {
    upstream = await fetchUpstream();
  } catch {
    try {
      await recoverProviderRuntime(false);
      recoveredProvider = true;
      if (!replayableRequest) return { starting: await startingResponse() };
      upstream = await fetchUpstream();
    } catch {
      return { starting: await startingResponse() };
    }
  }

  // E2B rotates the traffic token when the sandbox resumes. Drop the provider's
  // cached handle and retry a replayable request once with a fresh token.
  if (await isProviderIngressAuthFailure(provider(), upstream)) {
    await upstream.body?.cancel().catch(() => {});
    invalidateIngress();
    if (replayableRequest) {
      try {
        upstream = await fetchUpstream();
      } catch {
        try {
          await recoverProviderRuntime(false);
          recoveredProvider = true;
          upstream = await fetchUpstream();
        } catch {
          return { starting: await startingResponse() };
        }
      }
    }
  }

  // 400 was Daytona's shape. E2B reports a dead runtime as 5xx, so the check has
  // to see those statuses or the recovery below can never run for it.
  if (upstream.status === 400 || upstream.status >= 502) {
    const body = await upstream.clone().text().catch(() => '');
    if (appProviderStoppedResponse(provider(), upstream.status, body)) {
      await upstream.body?.cancel().catch(() => {});
      if (coldStart) return { starting: await startingResponse() };
      try {
        await recoverProviderRuntime(true);
        recoveredProvider = true;
        if (!replayableRequest) return { starting: await startingResponse() };
        upstream = await fetchUpstream();
      } catch {
        return { starting: await startingResponse() };
      }
      if (upstream.status === 400 || upstream.status >= 502) {
        const retryBody = await upstream.clone().text().catch(() => '');
        if (appProviderStoppedResponse(provider(), upstream.status, retryBody)) {
          await upstream.body?.cancel().catch(() => {});
          return { starting: await startingResponse() };
        }
      }
    }
  }

  return { upstream, recoveredProvider };
}
