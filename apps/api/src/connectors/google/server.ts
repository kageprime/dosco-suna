/**
 * Kortix's Google MCP servers: MCP Streamable HTTP, JSON responses, stateless.
 *
 * `POST /<service>` with `Authorization: Bearer <Google access token>`. The
 * token is the connection's own, refreshed by the gateway before each call;
 * this server holds no state and no Kortix credential. It answers:
 *
 *   - `initialize`, `ping`, `tools/list`, `tools/call`;
 *   - HTTP 401 when the bearer is missing or Google rejects the token, so the
 *     gateway marks the connection's credential rejected and asks for a new
 *     sign-in;
 *   - a tool error (`isError`) for everything else Google refuses, with
 *     Google's own message.
 *
 * {@link dispatchGoogleMcp} is the in-process entry `../egress.ts` uses for
 * every request to `https://google.mcp.kortix.com` (./host.ts).
 */
import { bearerToken } from '../../shared/bearer-token';
import { logger } from '../../lib/logger';
import { createGoogleClient, GoogleApiError, type GoogleFetch } from './client';
import { googleServiceForUrl, type GoogleService } from './host';
import { ToolInputError, type GoogleTool } from './tool';
import { GMAIL_TOOLS } from './gmail';
import { CALENDAR_TOOLS } from './calendar';
import { DRIVE_TOOLS } from './drive';
import { DOCS_TOOLS } from './docs';
import { SHEETS_TOOLS } from './sheets';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const SERVICE_TITLES: Record<GoogleService, string> = {
  gmail: 'Gmail',
  calendar: 'Google Calendar',
  drive: 'Google Drive',
  docs: 'Google Docs',
  sheets: 'Google Sheets',
};

export const GOOGLE_TOOLS: Record<GoogleService, readonly GoogleTool[]> = {
  gmail: GMAIL_TOOLS,
  calendar: CALENDAR_TOOLS,
  drive: DRIVE_TOOLS,
  docs: DOCS_TOOLS,
  sheets: SHEETS_TOOLS,
};

/** The MCP `tools/list` entry of a tool. */
export function toolListing(tool: GoogleTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { title: tool.title, ...tool.annotations },
  };
}

interface Rpc {
  id: string | number;
  method: string;
  params: Record<string, unknown>;
}

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

const rpcError = (id: unknown, code: number, message: string, status = 400): Answer => ({
  status,
  body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } },
});

const UNAUTHORIZED = (description: string): Answer => ({
  status: 401,
  body: { error: 'invalid_token', error_description: description },
  headers: { 'WWW-Authenticate': `Bearer error="invalid_token", error_description="${description}"` },
});

/** Above this, the text block points at structuredContent instead of repeating it (downloads reach 25 MB). */
const MAX_TEXT_COPY_CHARS = 64 * 1024;

function toolResult(output: unknown): Record<string, unknown> {
  const structured = output && typeof output === 'object' && !Array.isArray(output) ? (output as Record<string, unknown>) : { result: output };
  const json = JSON.stringify(structured);
  // MCP asks for the JSON in a text block too; a large answer would travel twice.
  const text = json.length <= MAX_TEXT_COPY_CHARS ? json : `The result is ${json.length} characters of JSON: read structuredContent.`;
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** What an agent can do about a Google refusal, appended to Google's message. */
function hint(error: GoogleApiError): string {
  if (error.status === 403 && (error.reason === 'insufficientPermissions' || error.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient.*scope/i.test(error.message))) {
    return ' The Google sign-in of this connection does not grant this. Ask the person to reconnect the connector.';
  }
  if (error.status === 404) return ' Check the id: it may belong to another account, or the item was deleted.';
  if (error.status === 429 || error.reason === 'rateLimitExceeded' || error.reason === 'userRateLimitExceeded') {
    return ' Google rate-limited this account. Wait a minute before you retry.';
  }
  return '';
}

async function callTool(service: GoogleService, rpc: Rpc, token: string, signal: AbortSignal, fetchImpl?: GoogleFetch): Promise<Answer> {
  const name = rpc.params.name;
  if (typeof name !== 'string') return rpcError(rpc.id, -32602, 'Invalid params: name must be a tool name');
  const tool = GOOGLE_TOOLS[service].find((t) => t.name === name);
  if (!tool) return rpcError(rpc.id, -32602, `Unknown tool: ${name}. tools/list names the ${SERVICE_TITLES[service]} tools.`);
  const args = rpc.params.arguments && typeof rpc.params.arguments === 'object' ? (rpc.params.arguments as Record<string, unknown>) : {};
  const google = createGoogleClient({ token, fetchImpl, signal });
  try {
    const output = await tool.run(args, { google });
    return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: toolResult(output) } };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: toolError(`Invalid arguments: ${error.message}`) } };
    }
    if (error instanceof GoogleApiError) {
      // An access token Google no longer accepts: the connection must sign in again.
      if (error.status === 401) return UNAUTHORIZED('Google rejected the access token');
      return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: toolError(`${error.message}${hint(error)}`) } };
    }
    logger.warn('[google-mcp] tool failed', { service, tool: name, error: error instanceof Error ? error.message : String(error) });
    return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: toolError(`${SERVICE_TITLES[service]} ${name} failed: ${error instanceof Error ? error.message : String(error)}`) } };
  }
}

async function answer(service: GoogleService, request: Request, fetchImpl?: GoogleFetch): Promise<Answer> {
  if (request.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' }, headers: { Allow: 'POST' } };
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(message)) return rpcError(null, -32600, 'Invalid Request: batches are not supported');
  if (!message || typeof message !== 'object' || (message as { jsonrpc?: unknown }).jsonrpc !== '2.0') {
    return rpcError(null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
  }
  const record = message as Record<string, unknown>;
  if (typeof record.method !== 'string') return { status: 202, body: null };
  // A notification: accepted, nothing to answer.
  if (record.id === undefined || record.id === null) return { status: 202, body: null };
  const rpc: Rpc = {
    id: record.id as string | number,
    method: record.method,
    params: record.params && typeof record.params === 'object' ? (record.params as Record<string, unknown>) : {},
  };
  const token = bearerToken(request.headers.get('authorization') ?? undefined);
  if (!token) return UNAUTHORIZED('A Google access token is required');
  switch (rpc.method) {
    case 'initialize': {
      const requested = String(rpc.params.protocolVersion ?? '');
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            serverInfo: { name: `kortix-google-${service}`, title: `${SERVICE_TITLES[service]} (Kortix)`, version: '1' },
            capabilities: { tools: {} },
          },
        },
      };
    }
    case 'ping':
      return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: {} } };
    case 'tools/list':
      return { status: 200, body: { jsonrpc: '2.0', id: rpc.id, result: { tools: GOOGLE_TOOLS[service].map(toolListing) } } };
    case 'tools/call':
      return callTool(service, rpc, token, request.signal, fetchImpl);
    default:
      return rpcError(rpc.id, -32601, `Method not found: ${rpc.method}`);
  }
}

/**
 * Serve one request to a Kortix Google MCP URL in-process. `fetchImpl` is the
 * test seam for Google's REST APIs.
 */
export async function dispatchGoogleMcp(request: Request, opts: { fetchImpl?: GoogleFetch } = {}): Promise<Response> {
  const service = googleServiceForUrl(request.url);
  if (!service) return Response.json({ error: 'not_found' }, { status: 404 });
  const result = await answer(service, request, opts.fetchImpl);
  if (result.status === 202 || result.body === null) return new Response(null, { status: result.status, headers: result.headers });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}
