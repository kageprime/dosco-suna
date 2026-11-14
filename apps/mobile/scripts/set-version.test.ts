import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readVersions, setVersion, VERSION_SITES } from './set-version.mjs';

const MOBILE = join(import.meta.dir, '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mobile-version-'));
  for (const file of [...new Set(VERSION_SITES.map(([file]) => file)), 'scripts/set-version.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(MOBILE, file), join(root, file));
  }
  return root;
}

function runNext(root: string) {
  return spawnSync('node', [join(root, 'scripts/set-version.mjs'), '--next'], { encoding: 'utf8' });
}

describe('app version', () => {
  test('every native copy carries the same version and runtimeVersion', () => {
    const found = readVersions();
    // Each site matched at least once: a renamed key must not drop out silently.
    expect(new Set(found.map((f) => f.file)).size).toBe(new Set(VERSION_SITES.map(([file]) => file)).size);
    expect(found.length).toBeGreaterThanOrEqual(VERSION_SITES.length);
    expect(new Set(found.map((f) => f.version))).toEqual(new Set([found[0].version]));
  });

  test('setVersion rewrites every site and rejects a non-semver value', () => {
    const root = mkdtempSync(join(tmpdir(), 'mobile-version-'));
    for (const [file] of VERSION_SITES) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      cpSync(join(MOBILE, file), join(root, file));
    }

    setVersion('9.8.7', root);
    expect(new Set(readVersions(root).map((f) => f.version))).toEqual(new Set(['9.8.7']));
    expect(() => setVersion('1.5', root)).toThrow('MAJOR.MINOR.PATCH');
    rmSync(root, { recursive: true });
  });

  test.each([
    ['1.6.2', '1.6.21'],
    ['1.5.6', '1.5.61'],
    ['1.5.61', '1.5.62'],
    ['1.5.62', '1.5.63'],
    ['1.6.29', '1.6.30'],
    ['1.6.99', '1.6.100'],
    ['1.0.0', '1.0.10'],
  ])('--next changes %s to %s in every native copy', (before, after) => {
    const root = fixture();
    try {
      setVersion(before, root);
      const result = runNext(root);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(VERSION_SITES.length);
      expect(new Set(readVersions(root).map(({ version }) => version))).toEqual(new Set([after]));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test.each(['mismatched', 'missing'])('--next refuses a %s version field without writing files', (kind) => {
    const root = fixture();
    try {
      const path = join(root, 'app.json');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      if (kind === 'mismatched') config.expo.runtimeVersion = '0.0.0';
      else delete config.expo.runtimeVersion;
      writeFileSync(path, JSON.stringify(config, null, 2));
      const files = [...new Set(VERSION_SITES.map(([file]) => file))];
      const before = files.map((file) => readFileSync(join(root, file), 'utf8'));
      const result = runNext(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(kind === 'mismatched' ? 'copies disagree' : 'version field missing');
      expect(files.map((file) => readFileSync(join(root, file), 'utf8'))).toEqual(before);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
