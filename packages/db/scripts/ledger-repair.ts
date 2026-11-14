import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './sha256';

/** Throws unless the migration file in `migrationsDir` hashes to the pinned sha256. */
export function verifyMigrationChecksum(
  migrationsDir: string,
  { filename, sha256 }: { filename: string; sha256: string },
): void {
  const actual = sha256Hex(readFileSync(join(migrationsDir, filename)));
  if (actual !== sha256) {
    throw new Error(`Migration checksum mismatch for ${filename}: expected ${sha256}, received ${actual}.`);
  }
}
