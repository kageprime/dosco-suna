import { config } from '../config';

/**
 * Write-time guards for URLs a person gives the API to fetch later: an audit
 * webhook URL, a connector's OpenAPI/GraphQL source URL, a connector endpoint.
 * They refuse non-https URLs and private hosts (the LFI/SSRF guard). The fetch
 * itself still goes through `safeEgressFetch`, which re-checks the resolved IP.
 */

/**
 * Stable error code for the expected "a person supplied an address we refuse
 * to fetch" validation state. Route handlers turn it into a structured 400
 * instead of letting the throw reach `app.onError` and Sentry: an expected
 * user-input validation state must not page like a server defect.
 */
export const INVALID_SOURCE_ADDRESS_CODE = 'invalid_source_address';

/**
 * Typed error from {@link assertAllowedSourceAddress} and
 * {@link assertAllowedEndpointUrl}. Carries a stable `code` so route handlers
 * branch on it (400) without swallowing genuine server failures.
 */
export class AllowedSourceValidationError extends Error {
  readonly code = INVALID_SOURCE_ADDRESS_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'AllowedSourceValidationError';
  }
}

/** Narrow an unknown to {@link AllowedSourceValidationError}. */
export function isAllowedSourceValidationError(err: unknown): err is AllowedSourceValidationError {
  return err instanceof AllowedSourceValidationError;
}

/**
 * True for a hostname that must never be fetched: loopback, link-local (cloud
 * metadata at 169.254.169.254), RFC 1918 ranges, and `.internal` / `.local`
 * names. A hostname check only; `safeEgressFetch` checks the resolved IP.
 */
export function isPrivateHostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  return false;
}

/** Throw with a clear reason unless `address` is an https URL on a public host. */
export function assertAllowedSourceAddress(address: string): void {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new AllowedSourceValidationError(`Unrecognized source address: "${address}" is not an absolute URL.`);
  }
  if (parsed.protocol !== 'https:' || isPrivateHostName(parsed.hostname)) {
    throw new AllowedSourceValidationError('Only https URLs on public hosts are allowed.');
  }
}

/**
 * Throw with a clear reason if a connector endpoint (MCP server URL, GraphQL
 * endpoint, HTTP base URL) is not a safe absolute https URL on a public host.
 * WHATWG `URL` normalises the scheme case, so `HTTP://host`, `ws://host`,
 * `localhost:3000/mcp` and `my server/mcp` all fail here as the typed
 * {@link AllowedSourceValidationError} the routes turn into a 400, instead of
 * dying later as an unhandled `UnsafeEgressError` (500 + Sentry).
 */
export function assertAllowedEndpointUrl(address: string): void {
  let parsed: URL;
  try {
    parsed = new URL(address.trim());
  } catch {
    throw new AllowedSourceValidationError(`Connector endpoint must be an absolute https URL: "${address}"`);
  }
  if (parsed.username || parsed.password) {
    throw new AllowedSourceValidationError('Connector endpoints must not embed credentials.');
  }
  // A host the operator listed (self-host internal APIs, the local test stack's
  // loopback) passes, as it does for the connector egress fetch itself.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (config.KORTIX_CONNECTOR_EGRESS_ALLOW_HOSTS.some((h) => h.toLowerCase() === host)) return;
  if (parsed.protocol !== 'https:' || isPrivateHostName(parsed.hostname)) {
    throw new AllowedSourceValidationError('Connector endpoints must use https on a public host.');
  }
}
