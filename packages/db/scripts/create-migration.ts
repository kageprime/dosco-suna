#!/usr/bin/env bun
/**
 * Scaffold a new hand-written migration with the house-rules template baked
 * in (lock_timeout/statement_timeout header, expand/contract checklist,
 * mixed-version-safe annotation slot).
 *
 *   bun scripts/create-migration.ts <slug>                normal .sql migration
 *   bun scripts/create-migration.ts <slug> --concurrent    the CONCURRENTLY
 *                                                           escape hatch (.concurrent.ts)
 *
 * For schema-shape changes prefer `pnpm migrate:generate <slug>` (drizzle-kit
 * diffs kortix.ts) — this script is for RLS, functions, data backfills, and
 * the two cases drizzle-kit can't express: CONCURRENTLY operations and
 * anything else that must opt out of the wrapping transaction.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { concurrentScaffold, handWrittenMigrationHeader } from './safety-header';
import { utcStamp } from './utc-stamp';

const MIGRATIONS_DIR = join(import.meta.dir, '..', 'migrations');


const args = process.argv.slice(2);
const concurrent = args.includes('--concurrent');
const slug = args.find((a) => !a.startsWith('--')) ?? '';

if (!/^[a-z0-9_]+$/.test(slug)) {
  console.error('Usage: bun scripts/create-migration.ts <slug> [--concurrent]   (slug matches /^[a-z0-9_]+$/)');
  process.exit(1);
}

const ts = utcStamp();

if (!existsSync(MIGRATIONS_DIR)) mkdirSync(MIGRATIONS_DIR, { recursive: true });

if (concurrent) {
  const target = join(MIGRATIONS_DIR, `${ts}_${slug}.concurrent.ts`);
  writeFileSync(target, concurrentScaffold(slug));
  console.log(`Created: packages/db/migrations/${ts}_${slug}.concurrent.ts`);
  console.log('Fill in the TODOs, then review with `pnpm --filter @kortix/db lint`.');
  process.exit(0);
}

const target = join(MIGRATIONS_DIR, `${ts}_${slug}.sql`);
writeFileSync(target, handWrittenMigrationHeader(slug));
console.log(`Created: packages/db/migrations/${ts}_${slug}.sql`);
console.log('Fill it in, delete the checklist lines that don\'t apply, then review with `pnpm --filter @kortix/db lint`.');
