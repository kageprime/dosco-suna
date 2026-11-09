/**
 * The proxy's refusal response: one JSON error body with the preview CORS pair
 * applied, moved out of `pre-prompt-env-sync.ts` (KRTX-4477) so every refusal
 * site that imports the proxy's error helper no longer reaches the env-sync
 * module. Every moved name stays re-exported from `pre-prompt-env-sync.ts`, so
 * all existing import paths keep resolving.
 */
import { previewCorsHeaders } from './preview-hosts';

/** One JSON error body with the proxy's CORS pair applied. Lives here rather
 *  than in the route because every refusal below builds one, and the route must
 *  not have to be evaluated to construct a response. */
export function jsonProxyError(
  body: Record<string, unknown>,
  status: number,
  origin?: string,
): Response {
  // The preview allowlist, as every proxy response: the preview cookie is
  // ambient on cross-site requests, so an arbitrary origin gets nothing.
  const headers = new Headers({
    'Content-Type': 'application/json',
    ...previewCorsHeaders(origin ?? ''),
  });
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : String(error || fallback);
}
