/**
 * Sandbox env/secrets client — the daemon `/env` endpoints, owned by the SDK.
 * The host never calls `authenticatedFetch('/env...')` itself.
 *
 * These are host-level environment variables / API keys (e.g. tool provider
 * keys, ELEVENLABS_API_KEY) stored in the sandbox, distinct from workspace
 * files. All requests go through `authenticatedFetch`, same auth path as every
 * other daemon call.
 *
 * Every call takes an explicit `baseUrl` (exactly like `triggersRequest` in
 * `./triggers`) rather than reading the module-global "active runtime". A
 * caller that keys its own cache on a specific instance URL (e.g.
 * `use-secrets.ts`'s `instanceUrl`) must talk to THAT instance — falling back
 * to whatever the global active runtime happens to be at call time risks
 * reading/writing secrets on the wrong sandbox.
 */
import { sandboxRequest } from './sandbox-request';

/** List all secrets (key → value). Daemon `GET /env`. */
export async function listEnv(baseUrl: string): Promise<Record<string, string>> {
  const data = await sandboxRequest<{ secrets?: Record<string, string> }>(baseUrl, '/env', undefined, {
    errorFallback: 'Failed to load secrets',
  });
  return data.secrets ?? {};
}

/** Set a single secret. Daemon `PUT /env/:key`. */
export async function setEnv(baseUrl: string, key: string, value: string): Promise<void> {
  await sandboxRequest(
    baseUrl,
    `/env/${encodeURIComponent(key)}`,
    { method: 'PUT', body: JSON.stringify({ value }) },
    { errorFallback: 'Failed to save secret' },
  );
}

/** Delete a single secret. Daemon `DELETE /env/:key`. */
export async function deleteEnv(baseUrl: string, key: string): Promise<void> {
  await sandboxRequest(baseUrl, `/env/${encodeURIComponent(key)}`, { method: 'DELETE' }, {
    errorFallback: 'Failed to delete secret',
  });
}

/** Grouped namespace for ergonomic use (also available as named exports). */
export const env = {
  list: listEnv,
  set: setEnv,
  delete: deleteEnv,
};
