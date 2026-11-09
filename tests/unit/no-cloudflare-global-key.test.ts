import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The account-wide Cloudflare Global API Key leaked in public history and was
// revoked (GHSA-gvj2-w9pq-xmgx). CI uses scoped API tokens only.
const root = join(import.meta.dirname, '..', '..');

describe('Cloudflare credentials in CI', () => {
  test('no workflow or action reads a Global API Key', () => {
    const dirs = ['.github/workflows', '.github/actions'];
    const files = dirs.flatMap((dir) =>
      readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join(dir, f)),
    );
    const offenders = files.filter((f) => /CLOUDFLARE_GLOBAL_API_KEY|X-Auth-Key/i.test(readFileSync(join(root, f), 'utf8')));
    expect(files.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
