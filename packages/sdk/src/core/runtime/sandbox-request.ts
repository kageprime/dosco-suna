/**
 * The sandbox request core shared by every daemon client that takes an
 * explicit `baseUrl` (`./env`, `./pty`, `./triggers`, `./kortix-master`): one
 * base-url guard, one error-body reader, one JSON request. The guard throws
 * `RuntimeNotReadyError` so callers classify the unresolved-runtime state with
 * `instanceof` (`classifySendError` in `../../react/use-session`), never by
 * string-matching a client-specific prefix.
 */
import { authenticatedFetch } from '../http/auth';
import { stripTrailingSlashes } from '../../platform/strings';
import { RuntimeNotReadyError } from './runtime-not-ready-error';

/**
 * Guard + trim the sandbox base url for a daemon call. A blank url is the
 * unresolved-runtime state (`runtime/client.ts`'s `getClient()` refuses it
 * with the same class) — never a relative fetch against the page origin.
 */
export function sandboxBaseUrl(baseUrl: string): string {
  if (!baseUrl) throw new RuntimeNotReadyError();
  return stripTrailingSlashes(baseUrl);
}

/** The daemon's error-body fields any sandbox client may surface. */
interface SandboxErrorBody {
  error?: unknown;
  message?: unknown;
  details?: unknown;
}

/**
 * The daemon's best error message for a non-2xx response — the union of the
 * per-client orders this core replaced, so every caller keeps its message.
 * Reads the body as text and parses defensively (some service actions reply
 * with an empty body); the raw text surfaces (truncated) only when it is not
 * JSON at all — a parsed body had its field chance.
 */
async function sandboxErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text();
  let body: SandboxErrorBody | null = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = null;
  }
  const detail = [body?.error, body?.message, body?.details].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return detail || res.statusText || (body === null ? text.slice(0, 200) : '') || fallback;
}

/**
 * JSON request against `${baseUrl}${path}`, surfacing the daemon's error body
 * on non-2xx responses. Reads the body as text first and parses defensively
 * (falls back to `{}`) rather than assuming every response — success or
 * error, from every one of these routes — is guaranteed valid JSON; some
 * service actions reply with an empty body.
 */
export async function sandboxRequest<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
  opts?: {
    /** Passthrough to `authenticatedFetch` (the services calls disable the shared 401 retry). */
    fetchOptions?: { retryOnAuthError?: boolean };
    /** Error message when the body, the statusText and the raw text are all empty. Default: `Request failed with <status>`. */
    errorFallback?: string;
  },
): Promise<T> {
  const response = await authenticatedFetch(
    `${sandboxBaseUrl(baseUrl)}${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
    },
    opts?.fetchOptions,
  );

  if (!response.ok) {
    throw new Error(
      await sandboxErrorMessage(response, opts?.errorFallback ?? `Request failed with ${response.status}`),
    );
  }

  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return body as T;
}
