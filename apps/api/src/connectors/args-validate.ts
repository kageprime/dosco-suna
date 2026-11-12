/**
 * Check a connector call's arguments against its action's `inputSchema`
 * before dispatch: every top-level `required` argument is present, and every
 * top-level argument has its declared JSON type. A mistake is answered as
 * `invalid_args` naming the argument, before any credential, approval or
 * upstream call. Before this, a call without a required argument reached the
 * provider and came back as `upstream_404`, which reads as a broken connector.
 *
 * Deliberately shallow and lenient, so a call that works today keeps
 * working: only the top level is checked; a required argument with a
 * `default` may be omitted; a value the upstream reads the same way passes
 * (a number for a `string`, `"42"` for a `number`, `"true"` for a `boolean`,
 * a JSON string for an `object` or `array`);
 * `anyOf`, `oneOf`, `$ref` and unknown types are not checked.
 */

import { ATTACHMENT_REF_KEY } from './attachment-inline';

type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
const JSON_TYPES = new Set<string>(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// A JSON-string request body is sent upstream as the object it encodes
// (`call.ts`), so a string that parses to the declared kind passes.
function parsedJson(value: unknown): unknown {
  if (typeof value !== 'string') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    case 'number':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
    case 'integer':
      return (typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^-?\d+$/.test(value.trim()));
    case 'boolean':
      return typeof value === 'boolean' || value === 'true' || value === 'false';
    case 'object':
      return isPlainObject(value) || isPlainObject(parsedJson(value));
    case 'array':
      return Array.isArray(value) || Array.isArray(parsedJson(value));
    case 'null':
      return value === null;
  }
}

function declaredTypes(property: unknown): JsonType[] | null {
  if (!isPlainObject(property)) return null;
  const raw = property.type;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0 || !list.every((t) => typeof t === 'string' && JSON_TYPES.has(t))) return null;
  return list as JsonType[];
}

/**
 * The reason a call's arguments do not fit the schema, written for the
 * caller, or null when they fit (or the schema declares nothing checkable).
 * `tool` is the full tool path the caller used, e.g. `wise.balances_list`.
 */
export function invalidArgsReason(
  schema: Record<string, unknown> | null | undefined,
  args: Record<string, unknown> | null | undefined,
  tool: string,
): string | null {
  if (!isPlainObject(schema)) return null;
  const values = args ?? {};
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [];

  for (const name of required) {
    const value = values[name];
    if (value !== undefined && value !== null) continue;
    const property = properties[name];
    if (isPlainObject(property) && 'default' in property) continue;
    if (value === null && declaredTypes(property)?.includes('null')) continue;
    return `The required argument ${name} is missing. Call ${tool} again with ${name} set: \`kortix connectors show ${tool}\` lists its arguments.`;
  }

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const property = properties[name];
    // Values the gateway rewrites before dispatch: a staged attachment
    // reference becomes the file's content, and a Composio file input takes a
    // URL in place of its object (`attachment-inline.ts`, `composio-files.ts`).
    if (isPlainObject(value) && ATTACHMENT_REF_KEY in value) continue;
    if (isPlainObject(property) && property.file_uploadable === true) continue;
    const types = declaredTypes(property);
    if (!types) continue;
    // An optional argument sent as null means "not set".
    if (value === null && !required.includes(name)) continue;
    if (types.some((type) => matchesType(value, type))) continue;
    return `The argument ${name} must be ${types.join(' or ')}, not ${typeName(value)}. Call ${tool} again with ${name} as ${types[0]}.`;
  }
  return null;
}
