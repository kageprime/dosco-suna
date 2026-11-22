import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const fixtures: string[] = [];
const scanner = resolve(import.meta.dirname, '../bin/reject-focused-tests.ts');
afterEach(() => fixtures.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function scan(path: string, focused: boolean, ignored = false) {
  const root = mkdtempSync(resolve(tmpdir(), 'focused-tests-'));
  fixtures.push(root);
  spawnSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), `test${focused ? '.only' : ''}('behavior', () => {});\n`);
  if (ignored) writeFileSync(resolve(root, '.gitignore'), 'scripts/generated/\n');
  return spawnSync('bun', [scanner], { cwd: root, encoding: 'utf8' });
}
for (const path of [
  'apps/demo/x.test.ts',
  'packages/demo/x.test.tsx',
  'tests/unit/x.spec.ts',
  'scripts/nested/x.test.ts',
  'scripts/x.test.mjs',
  'infra/worker/x.test.mjs',
]) {
  test(`rejects focused tests in ${path}`, () => {
    const result = scan(path, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('focused test (.only) committed');
    expect(result.stderr).toContain(path);
  });
}
test('accepts ordinary tests', () => expect(scan('scripts/x.test.mjs', false).status).toBe(0));
test('respects gitignored generated tests', () =>
  expect(scan('scripts/generated/x.test.ts', true, true).status).toBe(0));
test('fails closed outside a git repository', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'focused-tests-nongit-'));
  fixtures.push(root);
  const result = spawnSync('bun', [scanner], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('focused-test scan exited with code');
});
