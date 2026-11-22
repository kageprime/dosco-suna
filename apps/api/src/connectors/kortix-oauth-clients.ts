/**
 * `KORTIX_OAUTH_CLIENTS`: the OAuth clients Kortix owns, one per vendor whose
 * MCP server has no dynamic client registration (`./mcp-apps.ts`). Its own
 * module so the Composio catalogue can ask "is Kortix's Google client set?"
 * without importing the MCP app catalogue.
 */
import { config } from '../config';
import { logger } from '../lib/logger';

export interface KortixOAuthClient {
  client_id: string;
  client_secret: string;
}

let parsedClients: { raw: string; clients: Map<string, KortixOAuthClient> } | null = null;

/** `KORTIX_OAUTH_CLIENTS`, parsed once per value. A malformed value lists no client. */
export function kortixOAuthClients(raw: string = config.KORTIX_OAUTH_CLIENTS ?? ''): Map<string, KortixOAuthClient> {
  if (parsedClients?.raw === raw) return parsedClients.clients;
  const clients = new Map<string, KortixOAuthClient>();
  if (raw.trim()) {
    try {
      for (const [name, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        const entry = value as Partial<KortixOAuthClient> | null;
        if (typeof entry?.client_id === 'string' && entry.client_id && typeof entry.client_secret === 'string' && entry.client_secret) {
          clients.set(name, { client_id: entry.client_id, client_secret: entry.client_secret });
        }
      }
    } catch {
      logger.warn('[mcp-apps] KORTIX_OAUTH_CLIENTS is not valid JSON; no Kortix OAuth client is configured');
    }
  }
  parsedClients = { raw, clients };
  return clients;
}


/**
 * Composio toolkits a Kortix Google MCP server replaces (`./google`).
 * `googlesuper` bundles the same five services; an installed one keeps working.
 */
export const KORTIX_GOOGLE_TOOLKITS: readonly string[] = ['gmail', 'googlecalendar', 'googledrive', 'googledocs', 'googlesheets', 'googlesuper'];

/** The Composio toolkits Kortix serves itself on this deployment: its Google client is configured. */
export function kortixReplacedToolkits(clients = kortixOAuthClients()): readonly string[] {
  return clients.has('google') ? KORTIX_GOOGLE_TOOLKITS : [];
}
