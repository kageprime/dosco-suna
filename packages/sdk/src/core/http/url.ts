/**
 * The wire URL concerns the REST client shares: the backend base URL and the
 * query-string serializer. One owner each. This is a leaf module: it imports
 * nothing from `core/rest`, so any REST module can import it without
 * closing a cycle (KRTX-4504).
 */

import { platformConfig } from './config';
import { safeEnv } from './env';
import { stripTrailingSlashes } from '../../platform/strings';

/**
 * Get the base URL for platform API calls.
 *
 * Uses NEXT_PUBLIC_BACKEND_URL directly (includes /v1).
 */
export function getPlatformUrl(): string {
  // Server-side: prefer BACKEND_URL (internal Docker hostname) over
  // NEXT_PUBLIC_BACKEND_URL (browser-facing localhost, unreachable from container).
  // `safeEnv` because this module is isomorphic-core: a bare `process.env` read
  // throws a ReferenceError in a browser <script> bundle and on React Native.
  const backendUrl = safeEnv('BACKEND_URL') || platformConfig().backendUrl;
  if (backendUrl) {
    return backendUrl;
  }

  // Fallback for local dev
  return 'http://localhost:8008/v1';
}

/** Backend URL → platform API base: trailing slashes stripped, `/v1` appended when absent. */
export function platformApiBase(backendUrl: string): string {
  const base = stripTrailingSlashes(backendUrl);
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

/** Append only truthy filter values, preserving the existing URL encoding. */
export function appendQuery(entries: Record<string, string | number | null | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
