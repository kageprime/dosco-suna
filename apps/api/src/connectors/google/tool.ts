/**
 * One tool of a Kortix Google MCP server, plus the argument and schema helpers
 * every service file uses.
 *
 * Tool names and argument names follow the Composio toolkits that Kortix
 * Google connectors replace (`fetch_emails`, `events_list`, `find_file`, …),
 * so an agent, a skill or a tool rule written against Composio keeps working
 * after the connector moves. Each tool's `structuredContent` is the object the
 * Composio tool returned as its `data`.
 */
import type { GoogleClient } from './client';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
  google: GoogleClient;
}

export interface GoogleTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** The caller's arguments are wrong: the tool answers `isError` with this text. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

// ─── Schema helpers ─────────────────────────────────────────────────────────

type Prop = Record<string, unknown>;

export const s = (description: string, extra: Prop = {}): Prop => ({ type: 'string', description, ...extra });
export const i = (description: string, extra: Prop = {}): Prop => ({ type: 'integer', description, ...extra });
export const n = (description: string, extra: Prop = {}): Prop => ({ type: 'number', description, ...extra });
export const b = (description: string, extra: Prop = {}): Prop => ({ type: 'boolean', description, ...extra });
export const strs = (description: string, extra: Prop = {}): Prop => ({ type: 'array', items: { type: 'string' }, description, ...extra });
export const anyObj = (description: string, extra: Prop = {}): Prop => ({ type: 'object', additionalProperties: true, description, ...extra });
export const arr = (items: Prop, description: string, extra: Prop = {}): Prop => ({ type: 'array', items, description, ...extra });

export function schema(properties: Record<string, Prop>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: true };
}

/** `user_id`, which every Composio Google tool takes. Only `me` is served. */
export const USER_ID = s("The user's email address or `me`. Kortix acts as the signed-in account, so `me` is the only useful value.", { default: 'me' });

// ─── Argument readers ───────────────────────────────────────────────────────

export function optStr(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

export function reqStr(args: Record<string, unknown>, ...keys: string[]): string {
  const value = optStr(args, ...keys);
  if (value === undefined) throw new ToolInputError(`${keys[0]} is required`);
  return value;
}

export function optInt(args: Record<string, unknown>, key: string, fallback?: number, max?: number): number | undefined {
  const raw = args[key];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const whole = Math.trunc(value);
  return max !== undefined ? Math.min(whole, max) : whole;
}

export function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** A string list from an array, one string, or a comma-separated string. */
export function strList(args: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
    if (typeof value === 'string' && value.trim() !== '') return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

export function optObj(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      throw new ToolInputError(`${key} must be a JSON object`);
    }
  }
  return undefined;
}

/** Copy the listed keys that are set into a new object (Google request bodies). */
export function pick(args: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null && args[key] !== '') out[key] = args[key];
  }
  return out;
}

/** Run `work` over `items` with at most `limit` in flight, keeping order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
