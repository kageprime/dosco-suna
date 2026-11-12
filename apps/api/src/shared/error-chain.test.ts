import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  innermostMessage,
  isAuditContentionError,
  errorSqlstate,
} from './error-cause';
import { isUniqueViolation, uniqueViolationConstraint } from './postgres-errors';
import { inspectDatabaseError, isDatabaseError, isTransientDatabaseError } from './database-errors';

// Characterization: the cause-chain contracts every classifier shares. These
// pin the behavior the shared walk must keep — how deep a wrapped SQLSTATE is
// still classified, that a cycle terminates, and that a wrapper code does not
// shadow a contended cause.

function driverError(code: string, constraintName?: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    name: 'PostgresError',
    code,
    ...(constraintName ? { constraint_name: constraintName } : {}),
  });
}

describe('a wrapped 23505 classifies as a unique violation', () => {
  test('three cause links deep', () => {
    const error = { cause: { cause: { cause: driverError('23505') } } };
    expect(isUniqueViolation(error)).toBe(true);
  });

  test('the constraint name is read off the same depth', () => {
    const error = { cause: { cause: { cause: driverError('23505', 'projects_slug_key') } } };
    expect(uniqueViolationConstraint(error)).toBe('projects_slug_key');
  });

  test('a 23505 without a constraint name yields null, and other codes yield null', () => {
    expect(uniqueViolationConstraint({ cause: driverError('23505') })).toBeNull();
    expect(uniqueViolationConstraint({ cause: driverError('23503', 'other_key') })).toBeNull();
  });

  test('a cause cycle terminates', () => {
    const a: { cause?: unknown } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isUniqueViolation(a)).toBe(false);
    expect(uniqueViolationConstraint(a)).toBeNull();
  });
});

describe('a 57P03 inside a real DrizzleQueryError classifies as transient', () => {
  test('isTransientDatabaseError reads the wrapped driver SQLSTATE', () => {
    const error = new DrizzleQueryError(
      'insert into "kortix"."audit_events" values ($1)',
      ['probe'],
      driverError('57P03'),
    );
    expect(isTransientDatabaseError(error)).toBe(true);
  });

  test('a cause cycle terminates', () => {
    const a: { cause?: unknown; code?: string } = { code: '42P01' };
    const b: { cause?: unknown } = { cause: a };
    a.cause = b;
    expect(isTransientDatabaseError(a)).toBe(false);
  });
});

// Wrap `error` in `times` anonymous cause links, so the driver error sits at
// cause-chain position `times`.
function wrapped(error: unknown, times: number): unknown {
  let current = error;
  for (let i = 0; i < times; i += 1) current = { cause: current };
  return current;
}

describe('each classifier keeps its own code membership', () => {
  // Membership is per classifier by design: the audit pool's retry policy and
  // the database read retry's are different answers to "is this retryable",
  // so neither set may gain the other's codes. A cancelled statement (57014)
  // or an unavailable lock (55P03) is audit-pool contention, never a database
  // READ retry; the read retry's connection-phase codes (CONNECT_TIMEOUT,
  // EMAXCONNSESSION) are never audit contention.

  test('a cancelled statement is never a transient database read', () => {
    expect(
      isTransientDatabaseError(Object.assign(new Error('probe'), { code: '57014' })),
    ).toBe(false);
    expect(
      isTransientDatabaseError(Object.assign(new Error('probe'), { code: '55P03' })),
    ).toBe(false);
  });

  test('a driver connect-timeout is never audit contention', () => {
    expect(
      isAuditContentionError(Object.assign(new Error('probe'), { code: 'CONNECT_TIMEOUT' })),
    ).toBe(false);
    expect(
      isAuditContentionError(Object.assign(new Error('probe'), { code: 'EMAXCONNSESSION' })),
    ).toBe(false);
  });

  test('the audit pair never leaks into the read retry', () => {
    for (const code of [
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
      'CONNECTION_CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'EPIPE',
    ]) {
      expect(isTransientDatabaseError(Object.assign(new Error('probe'), { code }))).toBe(false);
    }
  });

  test('each classifier still retries exactly its own codes', () => {
    for (const code of [
      '40001',
      '40P01',
      '53300',
      '57P01',
      '57P02',
      '57P03',
      'CONNECT_TIMEOUT',
      'ECONNRESET',
      'ETIMEDOUT',
      'EMAXCONNSESSION',
    ]) {
      expect(isTransientDatabaseError(Object.assign(new Error('probe'), { code }))).toBe(true);
    }
    for (const code of [
      '57014',
      '55P03',
      '40001',
      '40P01',
      '57P01',
      '57P02',
      '57P03',
      '08000',
      '08003',
      '08006',
      '53300',
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
      'CONNECTION_CONNECT_TIMEOUT',
      'ECONNREFUSED',
      'ECONNRESET',
      'EPIPE',
      'ETIMEDOUT',
    ]) {
      expect(isAuditContentionError(Object.assign(new Error('probe'), { code }))).toBe(true);
    }
  });

  test('an 08-prefixed connection SQLSTATE stays a database-read transient via the prefix rule', () => {
    expect(
      isTransientDatabaseError(Object.assign(new Error('probe'), { code: '08006' })),
    ).toBe(true);
  });
});

describe('each classifier keeps its own walk depth', () => {
  // The shared walk gives up after 16 links, but a classifier that walked a
  // shorter chain before the consolidation still does: a code hidden deeper
  // than the caller's own bound must not newly classify.

  test('a 23505 past the fourth node is not a unique violation', () => {
    expect(isUniqueViolation(wrapped(driverError('23505'), 3))).toBe(true);
    expect(isUniqueViolation(wrapped(driverError('23505'), 4))).toBe(false);
    expect(uniqueViolationConstraint(wrapped(driverError('23505', 'projects_slug_key'), 3))).toBe(
      'projects_slug_key',
    );
    expect(uniqueViolationConstraint(wrapped(driverError('23505', 'projects_slug_key'), 4))).toBeNull();
  });

  test('a transient code past the eighth node is not a database-read transient', () => {
    expect(
      isTransientDatabaseError(wrapped(Object.assign(new Error('probe'), { code: '57P03' }), 7)),
    ).toBe(true);
    expect(
      isTransientDatabaseError(wrapped(Object.assign(new Error('probe'), { code: '57P03' }), 8)),
    ).toBe(false);
  });

  test('inspectDatabaseError keeps its own eighth-link reach', () => {
    expect(inspectDatabaseError(wrapped(driverError('57P03'), 7))).not.toBeNull();
    expect(inspectDatabaseError(wrapped(driverError('57P03'), 8))).toBeNull();
  });

  test('errorSqlstate and innermostMessage keep the leaf 16-link walk', () => {
    expect(errorSqlstate(wrapped(driverError('55P03'), 15))).toBe('55P03');
    expect(errorSqlstate(wrapped(driverError('55P03'), 16))).toBeNull();
    expect(
      innermostMessage(wrapped(Object.assign(new Error('timeout fired'), { cause: null }), 15)),
    ).toBe('timeout fired');
  });
});

describe('isAuditContentionError keeps its unbounded reach', () => {
  // The audit classifier's pre-consolidation walk had no depth cutoff — it
  // recursed down .cause until the chain ran out — so AuditQueue.flush sees
  // backpressure instead of a dead letter no matter how many wrappers the
  // driver error collected. It passes Infinity to the shared walk; the walk's
  // revisit guard (not a depth bound) is what terminates it.

  test('sixteen wrappers around 55P03 still classify', () => {
    expect(isAuditContentionError(wrapped(driverError('55P03'), 16))).toBe(true);
  });

  test('forty wrappers around 57014 still classify — no depth cutoff', () => {
    expect(isAuditContentionError(wrapped(driverError('57014'), 40))).toBe(true);
  });

  test('a contention-free chain stays false at any depth', () => {
    expect(isAuditContentionError(wrapped(driverError('23505'), 20))).toBe(false);
  });

  test('a cause cycle terminates: contention inside the cycle still classifies', () => {
    // At this head the shared walk's revisit guard is what terminates the
    // walk (a broken guard would hang here). The pre-consolidation recursion
    // had no revisit guard at all: this input returned early at the
    // contention code, while a contention-free cycle hung it.
    const a: { cause?: unknown; code?: string } = { code: '42P01' };
    const b: { cause?: unknown; code?: string } = { code: '55P03' };
    a.cause = b;
    b.cause = a;
    expect(isAuditContentionError(a)).toBe(true);
  });
});

describe('isAuditContentionError', () => {
  // The wrapper's own code is not in either contention set; the contended
  // cause underneath it must still classify (every node, not the first code).
  test('a synthetic wrapper code does not shadow a contended cause', () => {
    const error = Object.assign(new Error('wrapper'), {
      code: 'APP_OOPS',
      cause: driverError('55P03'),
    });
    expect(isAuditContentionError(error)).toBe(true);
  });

  test('a defect code on every node stays false', () => {
    expect(isAuditContentionError(driverError('23505'))).toBe(false);
    expect(isAuditContentionError(new Error('plain'))).toBe(false);
  });
});

describe('the walk never reads cause past a matched code', () => {
  // The trunk's errorSqlstate / isUniqueViolation / uniqueViolationConstraint /
  // isAuditContentionError returned at the first match WITHOUT reading that
  // node's cause — so a throwing cause getter below a matched code could not
  // break the match. The lazy walk keeps that: the getter is read only when
  // the consumer pulls the next node.
  const throwingCause = (outer: Record<string, unknown>) => {
    Object.defineProperty(outer, 'cause', {
      get() {
        throw new Error('cause getter threw');
      },
    });
    return outer;
  };

  test('errorSqlstate returns the matched outer code', () => {
    expect(errorSqlstate(throwingCause({ code: '57014' }))).toBe('57014');
  });

  test('isUniqueViolation and uniqueViolationConstraint return the matched outer code', () => {
    expect(isUniqueViolation(throwingCause({ code: '23505' }))).toBe(true);
    expect(uniqueViolationConstraint(throwingCause({ code: '23505', constraint_name: 'users_email' }))).toBe('users_email');
  });

  test('isAuditContentionError returns the matched outer code', () => {
    expect(isAuditContentionError(throwingCause({ code: '57014' }))).toBe(true);
  });

  test('the database walk stays eager: it reads every link even past a match, as the trunk walk did', () => {
    // database-errors built its whole 8-link array before checking; a throwing
    // cause getter throws there — kept by materializing the chain eagerly.
    expect(() => isDatabaseError(throwingCause({ name: 'PostgresError' }))).toThrow('cause getter threw');
    expect(() => isTransientDatabaseError(throwingCause({ code: '40001' }))).toThrow('cause getter threw');
  });
});
