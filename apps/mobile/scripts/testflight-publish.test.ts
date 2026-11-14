import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'testflight-publish.mjs');
const backend = 'https://api.kortix.com/v1';

// Run the real CLI process. Only the external EAS/Git programs and HTTP
// response are replaced; no build or store submission leaves these tests.
function run(args: string[] = [], overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'testflight-cli-'));
  const log = join(root, 'calls.jsonl');
  try {
    writeFileSync(join(root, 'eas'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'config') console.log(JSON.stringify({buildProfile: {
  environment: 'production', channel: process.env.CHANNEL || 'testflight-production', distribution: 'store'
}}));
else if (args[0] === 'env:get') console.log('EXPO_PUBLIC_BACKEND_URL=' + process.env.BACKEND);
else if (args[0] === 'build') console.log(JSON.stringify([{id: 'synthetic-build', platform: 'IOS', status: process.env.BUILD_STATUS || 'FINISHED'}]));
else if (args[0] === 'submit') process.exit(Number(process.env.SUBMIT_EXIT || 0));
else process.exit(9);
`);
    writeFileSync(join(root, 'git'), '#!/bin/sh\nprintf "%s" "$DIRTY"\n');
    chmodSync(join(root, 'eas'), 0o755);
    chmodSync(join(root, 'git'), 0o755);
    const preload = join(root, 'http.mjs');
    writeFileSync(preload, `globalThis.fetch = async (url, options) => {
  if (url !== '${backend}/health' || options?.method) throw new Error('unexpected HTTP request');
  return { ok: process.env.HEALTH_OK !== 'false', json: async () => ({environment: 'prod'}) };
};`);
    const result = spawnSync('node', ['--import', preload, script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, CALL_LOG: log, BACKEND: backend, ...overrides },
    });
    const calls: string[][] = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true });
  }
}

describe('production API TestFlight CLI', () => {
  test('builds iOS and uploads only that exact build to TestFlight', () => {
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.calls.slice(2)).toEqual([
      ['build', '--platform', 'ios', '--profile', 'prod-testflight', '--wait', '--json', '--non-interactive'],
      ['submit', '--platform', 'ios', '--profile', 'prod-testflight', '--id', 'synthetic-build', '--non-interactive', '--wait'],
    ]);
    expect(result.stdout).toContain('Uploaded synthetic-build to TestFlight');
  });

  test('dry run checks the production environment without building or submitting', () => {
    const result = run(['--dry-run']);
    expect(result.status).toBe(0);
    expect(result.calls.map((args) => args[0])).toEqual(['config', 'env:get']);
    expect(result.stdout).toContain('No build or submission started');
  });

  test.each([
    [{ BACKEND: 'https://dev-api.example.test/v1' }, 'production API'],
    [{ CHANNEL: 'production' }, 'testflight-production channel'],
    [{ HEALTH_OK: 'false' }, 'health check failed'],
    [{ DIRTY: ' M app.json' }, 'commit all changes'],
  ])('refuses an unsafe preflight state %j', (overrides, error) => {
    const result = run([], overrides);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.calls.some((args) => args[0] === 'build' || args[0] === 'submit')).toBe(false);
  });

  test('does not upload an unfinished build', () => {
    const result = run([], { BUILD_STATUS: 'ERRORED' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no finished iOS build');
    expect(result.calls.some((args) => args[0] === 'submit')).toBe(false);
  });

  test('a failed upload fails the command', () => {
    const result = run([], { SUBMIT_EXIT: '1' });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Uploaded synthetic-build');
  });
});
