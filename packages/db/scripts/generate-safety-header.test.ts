/**
 * A GENERATED migration must be born with the same safety header a
 * hand-written one gets.
 *
 * `migrate:create` has pre-filled `set lock_timeout` / `set statement_timeout`
 * since the zero-downtime policy landed. `migrate:generate` did not — it
 * renamed drizzle-kit's output into migrations/ untouched. So every generated
 * migration started life failing squawk's `require-timeout-settings`, and only
 * passed if the author noticed and pasted the header in by hand.
 *
 * That is not a hypothetical: 20260805030712000_enterprise_entitled_flag.sql
 * was generated, shipped without the header, merged with the check red, and
 * then failed the lint on every unrelated PR afterwards — because squawk's
 * target set is "every non-exempt migration", not "the ones this PR adds".
 *
 * One module (`safety-header.ts`) renders the header for both scaffolds, so
 * these tests pin the rendered text itself instead of grepping two source
 * files that had to stay in sync by hand.
 */
import { describe, expect, test } from 'bun:test';
import { lintMigration, parseLockTimeoutMs } from './lint-migrations';
import { concurrentScaffold, generatedMigrationHeader, handWrittenMigrationHeader } from './safety-header';

const GENERATE = generatedMigrationHeader('add_widget_table');
const CREATE = handWrittenMigrationHeader('add_widget_table');
const CONCURRENT = concurrentScaffold('add_widget_index');

/** The `set <name> = '<value>';` statements a template emits into the SQL. */
function timeouts(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/set (lock_timeout|statement_timeout) = '([^']+)'/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

// create-migration.ts holds TWO templates with different timeout budgets: the
// .concurrent.ts escape hatch (a long lock_timeout, because CREATE INDEX
// CONCURRENTLY waits on every older transaction) and the plain .sql header (the
// short house value, because its DDL blocks queries).
describe('generate.ts safety header', () => {
  test('emits both timeout statements', () => {
    const t = timeouts(GENERATE);
    expect(t.lock_timeout).toBeDefined();
    expect(t.statement_timeout).toBeDefined();
  });

  test('uses the SAME values as the hand-written template', () => {
    // Two headers that disagree would make "which command did you use?" a
    // silent input to how safe the migration is.
    expect(timeouts(GENERATE)).toEqual(timeouts(CREATE));
  });

  test('the header carries the enforced annotation lines', () => {
    // lint-migrations.ts fails any DROP/RENAME/ALTER TYPE without these, and a
    // generated diff is exactly where an unreviewed one appears.
    expect(GENERATE).toContain('mixed-version-safe:');
    expect(GENERATE).toContain('enum-value-checked:');
  });

  test('tells the author to review the generated SQL', () => {
    // drizzle knows the target shape, not how to reach it without downtime.
    expect(GENERATE).toContain('REVIEW THE GENERATED SQL');
  });

  test('pins the house-rules preamble byte for byte', () => {
    // The part every scaffold shares: the name line, the house-rules pointer,
    // and the two timeout statements. A wording change here is a migration-
    // contract change and must land through this test.
    const preamble = GENERATE.slice(0, GENERATE.indexOf('\n\n', GENERATE.indexOf("set statement_timeout = '30s';")) + 2);
    expect(preamble).toBe(`-- Migration: add_widget_table
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

`);
  });
});

describe('the .concurrent.ts template', () => {
  test('scaffolds a lock_timeout at or above the lint floor', () => {
    // The template and lint-migrations.ts must not drift apart: a scaffold that
    // emits a value its own linter rejects would fail every new migration on
    // the first `pnpm --filter @kortix/db lint`.
    const value = timeouts(CONCURRENT).lock_timeout;
    expect(value).toBeDefined();
    expect(parseLockTimeoutMs(value)).toBeGreaterThanOrEqual(120_000);
  });

  test('the scaffolded file passes its own lint', () => {
    // The end-to-end contract: what `migrate:create --concurrent` writes must
    // be lint-clean once the TODOs are filled in.
    const scaffold = [
      'export const up = (pgm) => {',
      '  pgm.noTransaction();',
      `  pgm.sql(\`set lock_timeout = '${timeouts(CONCURRENT).lock_timeout}'\`);`,
      '  pgm.sql(`create index concurrently if not exists idx_widgets_name on kortix.widgets (name)`);',
      '};',
    ].join('\n');
    const { errors } = lintMigration('20260101000000000_add_widget_index.concurrent.ts', scaffold);
    expect(errors).toEqual([]);
  });

  test('keeps a generous statement_timeout for long index builds', () => {
    // A CIC on a large table legitimately runs for minutes; the .sql header's
    // 30s budget would kill it.
    const value = timeouts(CONCURRENT).statement_timeout;
    expect(value).toBeDefined();
    expect(parseLockTimeoutMs(value)).toBeGreaterThanOrEqual(600_000);
  });
});
