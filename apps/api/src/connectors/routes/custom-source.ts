/**
 * The one approval step an agent session meets when it adds a connector: a
 * server nobody chose yet. The catalogue is an index, not a list of what may be
 * connected, so it decides nothing here beyond "a published URL is a chosen
 * one". `POST /connectors` and `POST /discover/install` both ask it.
 */
import type { Context } from 'hono';
import { connectorIdentity } from '../catalog-install';
import type { ConnectorRouterDeps } from '../router-contract';

/** The remote address a draft points calls at, or null (a toolkit, a repo file). */
function remoteSourceOf(draft: Record<string, unknown>): string | null {
  for (const key of ['url', 'endpoint', 'baseUrl', 'spec'] as const) {
    const value = draft[key];
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) return value.trim();
  }
  return null;
}

/**
 * Null, or the `403 custom_connector_needs_human` body: the server is one no
 * person approved yet. An approved server is one this workspace already has a
 * profile for, or an MCP URL the catalogue publishes. A person approves any
 * other server once, on the page `setup_url` opens: the page adds that exact
 * URL to kortix.yaml on main. A `baseUrl` from an agent always needs that
 * approval: it redirects every call of an existing profile.
 *
 * Only an agent session meets this step. A person adding a server IS the
 * approval.
 */
export async function customSourceRefusal(
  c: Context,
  deps: ConnectorRouterDeps,
  projectId: string,
  draft: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const source = remoteSourceOf(draft);
  if (!source || !deps.isAgentCaller?.(c)) return null;
  if (draft.baseUrl === undefined) {
    const identity = connectorIdentity(draft as Parameters<typeof connectorIdentity>[0]);
    const known = identity
      ? ((await deps.listConnectorIdentities?.(projectId)) ?? []).some((p) => p.identity === identity)
      : false;
    if (known) return null;
    if (draft.provider === 'mcp' && (await deps.catalogPublishesMcpUrl?.(source))) return null;
  }
  return {
    error:
      `This connector needs a one-time approval: ${source} is a server nobody in this workspace approved yet. ` +
      'A person who manages connectors (an owner, admin or manager) approves it at setup_url; it is then added to kortix.yaml on main.',
    code: 'custom_connector_needs_human',
    setup_url: deps.customConnectorSetupUrl?.(projectId, draft) ?? null,
  };
}
