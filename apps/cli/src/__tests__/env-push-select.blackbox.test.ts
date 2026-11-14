import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The one-prompt setup shows a person the NAMES in their .env and uploads only
// the names they approve: `env push --names` prints names and never a value,
// `--only` / `--exclude` select, and dotenvx ciphertext is never uploaded.

const CLI_ENTRY = join(resolve(import.meta.dir, '..', '..'), 'src', 'index.ts');
let dir: string;

function kortix(args: string[]) {
  const r = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, KORTIX_NO_UPDATE_CHECK: '1', NO_COLOR: '1' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kortix-env-'));
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://synthetic\nexport STRIPE_KEY="sk_test_synthetic"\nSEALED=encrypted:BAsynthetic\nEMPTY=\nLOCAL_API=http://localhost:3000/api\nVITE_BACKEND_URL=https://synthetic-team.example.cloud\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('--names lists every name with a value and never prints a value', () => {
  const r = kortix(['env', 'push', '--from', '.env', '--names', '--json']);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).names).toEqual([
    { name: 'DATABASE_URL', empty: false, encrypted: false, remote: true },
    { name: 'STRIPE_KEY', empty: false, encrypted: false, remote: false },
    { name: 'SEALED', empty: false, encrypted: true, remote: false },
    { name: 'EMPTY', empty: true, encrypted: false, remote: false },
    { name: 'LOCAL_API', empty: false, encrypted: false, remote: false },
    { name: 'VITE_BACKEND_URL', empty: false, encrypted: false, remote: true },
  ]);
  expect(r.stdout + r.stderr).not.toContain('synthetic');
});

test('a name the file lacks is refused before any upload', () => {
  const r = kortix(['env', 'push', '--from', '.env', '--only', 'DATABASE_URL,NOPE']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('NOPE');
});

test('dotenvx ciphertext is skipped; selecting only it uploads nothing', () => {
  const r = kortix(['env', 'push', '--from', '.env', '--only', 'SEALED']);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('dotenvx-encrypted: SEALED');
  expect(r.stderr).toContain('No name left to upload');
});
