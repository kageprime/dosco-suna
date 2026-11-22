/**
 * The Google REST client behind Kortix's Google MCP servers.
 *
 * Every request carries the connection's Google access token and goes to a
 * `googleapis.com` host: the client refuses any other host, so the `request`
 * tool cannot point a user's token anywhere else. Rate limits (429, and
 * Google's 403 `rateLimitExceeded` / `userRateLimitExceeded`) and transient
 * 5xx answers are retried twice with backoff; `Retry-After` is honoured up to
 * {@link MAX_RETRY_WAIT_MS}.
 */

export type GoogleFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface GoogleRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, unknown>;
  /** JSON body. Use {@link GoogleRequest.rawBody} for any other media type. */
  body?: unknown;
  rawBody?: { contentType: string; data: Uint8Array | string };
  headers?: Record<string, string>;
}

export interface GoogleClient {
  /** A JSON answer; `null` for an empty 204. */
  json<T = Record<string, unknown>>(request: GoogleRequest): Promise<T>;
  /** The raw bytes and media type of the answer (downloads, exports). */
  bytes(request: GoogleRequest): Promise<{ data: Uint8Array; contentType: string }>;
  /** The full answer for the `request` tool: status, headers and parsed body. */
  raw(request: GoogleRequest): Promise<{ status: number; contentType: string; body: unknown }>;
}

export class GoogleApiError extends Error {
  readonly status: number;
  /** Google's machine-readable reason (`notFound`, `insufficientPermissions`, …). */
  readonly reason: string | null;
  constructor(status: number, message: string, reason: string | null) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
    this.reason = reason;
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError']);
const BACKOFF_MS = [400, 1_200];
const MAX_RETRY_WAIT_MS = 5_000;
const ERROR_MESSAGE_CHARS = 600;

/** `www.googleapis.com`, `gmail.googleapis.com`, … Nothing else. */
export function isGoogleApiHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'googleapis.com' || lower.endsWith('.googleapis.com');
}

function buildUrl(request: GoogleRequest): URL {
  const url = new URL(request.url);
  if (url.protocol !== 'https:' || !isGoogleApiHost(url.hostname)) {
    throw new GoogleApiError(400, `Kortix sends Google requests only to https://*.googleapis.com, not ${url.origin}`, 'invalidHost');
  }
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function errorFrom(status: number, text: string): GoogleApiError {
  let message = text.trim();
  let reason: string | null = null;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; status?: unknown; errors?: Array<{ reason?: unknown }> } | string; error_description?: unknown };
    if (parsed && typeof parsed.error === 'object' && parsed.error) {
      if (typeof parsed.error.message === 'string') message = parsed.error.message;
      const first = Array.isArray(parsed.error.errors) ? parsed.error.errors[0] : undefined;
      if (typeof first?.reason === 'string') reason = first.reason;
      else if (typeof parsed.error.status === 'string') reason = parsed.error.status;
    } else if (typeof parsed?.error === 'string') {
      reason = parsed.error;
      if (typeof parsed.error_description === 'string') message = parsed.error_description;
    }
  } catch {
    // Not JSON: keep the text.
  }
  return new GoogleApiError(status, `Google answered ${status}: ${message.slice(0, ERROR_MESSAGE_CHARS) || 'no message'}`, reason);
}

function retryWaitMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  const seconds = header ? Number(header) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  return BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!;
}

/** JSON, text and XML answers are returned as text; anything else as base64. */
function isTextual(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return !type || type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('csv');
}

async function isRetryable(response: Response): Promise<boolean> {
  if (RETRY_STATUSES.has(response.status)) return true;
  if (response.status !== 403) return false;
  const text = await response.clone().text().catch(() => '');
  return [...RETRY_REASONS].some((reason) => text.includes(`"${reason}"`));
}

export function createGoogleClient(opts: {
  token: string;
  fetchImpl?: GoogleFetch;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): GoogleClient {
  const fetchImpl: GoogleFetch = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function send(request: GoogleRequest): Promise<Response> {
    const url = buildUrl(request);
    const headers: Record<string, string> = { Authorization: `Bearer ${opts.token}`, ...request.headers };
    let body: BodyInit | undefined;
    if (request.rawBody) {
      headers['Content-Type'] = request.rawBody.contentType;
      body = request.rawBody.data as BodyInit;
    } else if (request.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(request.body);
    }
    const init: RequestInit = { method: request.method ?? 'GET', headers, body, signal: opts.signal };
    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      const response = await fetchImpl(url.href, init);
      if (response.ok) return response;
      if (attempt < BACKOFF_MS.length && (await isRetryable(response))) {
        await response.body?.cancel().catch(() => {});
        await sleep(retryWaitMs(response, attempt));
        continue;
      }
      throw errorFrom(response.status, await response.text().catch(() => ''));
    }
  }

  return {
    async json<T>(request: GoogleRequest): Promise<T> {
      const response = await send(request);
      const text = await response.text();
      if (!text) return null as T;
      return JSON.parse(text) as T;
    },
    async bytes(request) {
      const response = await send(request);
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      };
    },
    async raw(request) {
      const response = await send(request);
      const contentType = response.headers.get('content-type') ?? '';
      const data = new Uint8Array(await response.arrayBuffer());
      if (!isTextual(contentType)) {
        return { status: response.status, contentType, body: { content_base64: Buffer.from(data).toString('base64'), size: data.byteLength } };
      }
      const text = new TextDecoder().decode(data);
      let body: unknown = text;
      if (contentType.includes('json') && text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { status: response.status, contentType, body };
    },
  };
}
