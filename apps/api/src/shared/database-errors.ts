import { DrizzleQueryError } from 'drizzle-orm/errors';
import { errorChain, TRANSIENT_DATABASE_CODES } from './error-cause';

export interface DatabaseErrorDetails {
  isDatabaseError: true;
  outerName: string;
  outerMessage: string;
  causeName: string | null;
  causeMessage: string | null;
  pgCode: string | null;
  severity: string | null;
  table: string | null;
  schema: string | null;
  detail: string | null;
  hint: string | null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isPostgresCode(code: string | null): boolean {
  return code !== null && (/^[0-9A-Z]{5}$/.test(code) || code === 'EMAXCONNSESSION');
}

export function inspectDatabaseError(error: unknown): DatabaseErrorDetails | null {
  // Eager, like the trunk's database walk: every link up to 8 is read before
  // any check, so a throwing `cause` getter throws here exactly as before.
  const chain = Array.from(errorChain(error, 8));
  if (chain.length === 0) return null;

  const postgresNode = chain.find((node) => {
    const name = stringField(node.name);
    const code = stringField(node.code);
    return (
      name === 'PostgresError'
      || stringField(node.severity) !== null
      || isPostgresCode(code)
    );
  });
  const databaseNode =
    postgresNode
    ?? chain.find((node) => stringField(node.name) === 'DrizzleQueryError');
  if (!databaseNode) return null;

  const outer = chain[0];
  const cause = databaseNode === outer ? null : databaseNode;
  return {
    isDatabaseError: true,
    outerName: stringField(outer.name) ?? 'Error',
    outerMessage: stringField(outer.message) ?? String(error),
    causeName: cause ? stringField(cause.name) : null,
    causeMessage: cause ? stringField(cause.message) : null,
    pgCode: stringField(databaseNode.code),
    severity: stringField(databaseNode.severity),
    table: stringField(databaseNode.table),
    schema: stringField(databaseNode.schema_name) ?? stringField(databaseNode.schema),
    detail: stringField(databaseNode.detail),
    hint: stringField(databaseNode.hint),
  };
}

/**
 * Throws `error` again when it, or an error in its cause chain, came from the
 * database driver. A route catch-all calls it before echoing the caught
 * message: `DrizzleQueryError.message` is the whole statement and its bound
 * parameters. The global handler answers a 500 and keeps the query in the log
 * (KRTX-3422). Matches the driver classes, not a SQLSTATE-shaped `code`, so a
 * socket `EPIPE` keeps its route's answer.
 */
export function rethrowDatabaseError(error: unknown): void {
  if (isDatabaseError(error)) throw error;
}

/** True when `error`, or an error in its cause chain, came from the database driver. */
export function isDatabaseError(error: unknown): boolean {
  return Array.from(errorChain(error, 8)).some(
    (node) => node instanceof DrizzleQueryError || stringField(node.name) === 'PostgresError',
  );
}

/**
 * A database error without its statement: `Database error (SQLSTATE 22P02):
 * <driver message>`. Null for any other error. For a route that must tell an
 * operator what failed (`adminErrorMessage`) instead of a generic 500.
 */
export function databaseErrorSummary(error: unknown): string | null {
  if (!isDatabaseError(error)) return null;
  const chain = Array.from(errorChain(error, 8));
  const sqlstate = chain.map((node) => stringField(node.code)).find((code) => code !== null);
  const driverMessage = chain
    .map((node) => stringField(node.message))
    .reverse()
    .find((message) => message !== null && !message.startsWith('Failed query'));
  return `Database error${sqlstate ? ` (SQLSTATE ${sqlstate})` : ''}: ${driverMessage?.split('\n')[0] ?? 'the query failed'}`;
}

export function isTransientDatabaseError(error: unknown): boolean {
  // One eager walk shared by both halves, like the trunk's 8-link array: a
  // throwing `cause` getter throws before any check, exactly as before.
  const chain = Array.from(errorChain(error, 8));
  for (const node of chain) {
    const code = stringField(node.code);
    if (code?.startsWith('08') || (code && TRANSIENT_DATABASE_CODES.has(code))) {
      return true;
    }
  }

  const text = chain
    .flatMap((node) => [stringField(node.name), stringField(node.message)])
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  return (
    text.includes('max clients reached')
    || text.includes('connection terminated unexpectedly')
    || text.includes('connection reset')
    || text.includes('socket closed')
  );
}

export async function retryTransientDatabaseRead<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientDatabaseError(error)) throw error;
    return operation();
  }
}
