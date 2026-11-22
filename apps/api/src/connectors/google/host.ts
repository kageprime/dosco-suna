/**
 * Kortix's own Google MCP servers: one per Google service, served by this API
 * in-process and never over the network.
 *
 * The catalogue (`../mcp-apps.ts`) lists Gmail, Google Calendar, Drive, Docs
 * and Sheets as `mcp` connectors whose URL is `https://google.mcp.kortix.com/<service>`.
 * The URL is an identity, not an address: `../egress.ts` hands every request
 * for this origin to {@link dispatchGoogleMcp} inside the API process, and the
 * name does not resolve in DNS, so a request that bypassed the egress would
 * fail closed. The only network traffic is the server's own calls to
 * `*.googleapis.com` with the connection's Google access token.
 *
 * Keeping the connectors on the `mcp` provider reuses everything the
 * catalogue already does for an MCP app signed in with a Kortix OAuth client:
 * the one-click sign-in, the tool sync, the move off Composio and the polled
 * app events.
 */

export const KORTIX_GOOGLE_MCP_ORIGIN = 'https://google.mcp.kortix.com';

export const GOOGLE_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets'] as const;
export type GoogleService = (typeof GOOGLE_SERVICES)[number];

const SERVICE_SET: ReadonlySet<string> = new Set(GOOGLE_SERVICES);

export function isGoogleService(value: string): value is GoogleService {
  return SERVICE_SET.has(value);
}

/** The catalogue URL of one Kortix Google MCP server. */
export function googleMcpUrl(service: GoogleService): string {
  return `${KORTIX_GOOGLE_MCP_ORIGIN}/${service}`;
}

/** The service a Kortix Google MCP URL names, or `null` for any other URL. */
export function googleServiceForUrl(url: string | URL): GoogleService | null {
  let parsed: URL;
  try {
    parsed = typeof url === 'string' ? new URL(url) : url;
  } catch {
    return null;
  }
  if (parsed.origin !== KORTIX_GOOGLE_MCP_ORIGIN || parsed.search || parsed.hash) return null;
  const service = parsed.pathname.replace(/^\/+|\/+$/g, '');
  return isGoogleService(service) ? service : null;
}
