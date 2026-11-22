import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Characterizes the per-placeholder rewrite BLOCKS of docker-entrypoint.sh (the
// section that builds $SED_SCRIPT), which the shipped docker-entrypoint.test.mjs
// does not cover — it only exercises the final `find | xargs sed` apply step.
// This pins that each baked placeholder is turned into its runtime value and
// that the shared `rewrite()` helper logs each one (except the backend host,
// which by design logs nothing and is covered by the backend URL line).

const ENTRYPOINT = join(import.meta.dir, 'docker-entrypoint.sh');

const BAKED = {
  supabase: 'https://placeholder.supabase.co',
  anon: 'local-build-placeholder-anon-key',
  backend: 'http://localhost:8008/v1',
  backendHost: 'http://localhost:8008',
  app: 'http://localhost:3000',
};
const RUNTIME = {
  supabase: 'https://real.supabase.co',
  anon: 'real-anon-key',
  backend: 'https://api.real.com/v1',
  backendHost: 'https://api.real.com',
  app: 'https://app.real.com',
};

/**
 * GNU `sed -i` takes no suffix; BSD sed (darwin) reads the next arg as the
 * backup suffix. Shim sed on PATH there so the test runs the shipped pipeline
 * verbatim (same approach as docker-entrypoint.test.mjs). Linux/CI uses GNU sed.
 */
function shimBinDir() {
  if (process.platform !== 'darwin') return null;
  const bin = mkdtempSync(join(tmpdir(), 'kortix-shim-'));
  const sed = join(bin, 'sed');
  writeFileSync(
    sed,
    [
      '#!/bin/sh',
      'n=$#',
      'while [ "$n" -gt 0 ]; do',
      '  a=$1; shift',
      '  if [ "$a" = "-i" ]; then set -- "$@" -i ""; else set -- "$@" "$a"; fi',
      '  n=$((n - 1))',
      'done',
      'exec /usr/bin/sed "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(sed, 0o755);
  return bin;
}

/** The shipped script, patched only to point at a test bundle and skip the exec. */
function runnableScript(bundleDir) {
  const source = readFileSync(ENTRYPOINT, 'utf8');
  const patched = source
    .replace('BUNDLE_DIR="/app/apps/web/.next"', `BUNDLE_DIR="${bundleDir}"`)
    .replace('exec node apps/web/server.js', 'exit 0');
  if (patched === source) throw new Error('could not patch docker-entrypoint.sh for the test');
  const path = join(mkdtempSync(join(tmpdir(), 'kortix-entrypoint-run-')), 'entrypoint.sh');
  writeFileSync(path, patched);
  return path;
}

function makeBundle(
  body = [
    `const supabase = "${BAKED.supabase}";`,
    `const anon = "${BAKED.anon}";`,
    `const backend = "${BAKED.backend}";`,
    `const backendHost = "${BAKED.backendHost}";`,
    `const app = "${BAKED.app}";`,
    `const cfg = { BILLING_ENABLED:!0 };`,
    '',
  ].join('\n'),
) {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-entrypoint-blocks-'));
  mkdirSync(join(dir, 'static'), { recursive: true });
  writeFileSync(join(dir, 'static', 'main.js'), body);
  writeFileSync(join(dir, 'index.html'), body);
  return dir;
}

/** Run the patched entrypoint over `bundle` with only `env` as the runtime values. */
function run(bundle, env) {
  const bin = shimBinDir();
  return spawnSync('/bin/sh', [runnableScript(bundle)], {
    env: { PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH, ...env },
    encoding: 'utf8',
  });
}

const RUNTIME_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: RUNTIME.supabase,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: RUNTIME.anon,
  NEXT_PUBLIC_BACKEND_URL: RUNTIME.backend,
  NEXT_PUBLIC_APP_URL: RUNTIME.app,
};

describe('docker-entrypoint.sh placeholder blocks', () => {
  test('rewrites every baked placeholder to its runtime value and logs each (not the backend host)', () => {
    const bundle = makeBundle();
    const bin = shimBinDir();
    const result = spawnSync('/bin/sh', [runnableScript(bundle)], {
      env: {
        ...process.env,
        PATH: bin ? `${bin}:${process.env.PATH}` : process.env.PATH,
        NEXT_PUBLIC_SUPABASE_URL: RUNTIME.supabase,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: RUNTIME.anon,
        NEXT_PUBLIC_BACKEND_URL: RUNTIME.backend,
        NEXT_PUBLIC_APP_URL: RUNTIME.app,
        // NEXT_PUBLIC_BILLING_ENABLED unset -> defaults to false -> baked !0 -> !1
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    for (const rel of ['static/main.js', 'index.html']) {
      const text = readFileSync(join(bundle, rel), 'utf8');
      expect(text).toContain(`const supabase = "${RUNTIME.supabase}";`);
      expect(text).toContain(`const anon = "${RUNTIME.anon}";`);
      expect(text).toContain(`const backend = "${RUNTIME.backend}";`);
      expect(text).toContain(`const backendHost = "${RUNTIME.backendHost}";`);
      expect(text).toContain(`const app = "${RUNTIME.app}";`);
      expect(text).not.toContain(BAKED.supabase);
      expect(text).not.toContain(BAKED.anon);
    }
    // The billing flag rewrite is .js-only (a separate block, unchanged here).
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).toContain('BILLING_ENABLED:!1');
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).not.toContain('BILLING_ENABLED:!0');

    // rewrite() logs each replacement; the backend-host block logs nothing.
    expect(result.stdout).toContain('[entrypoint] Supabase URL:');
    expect(result.stdout).toContain('[entrypoint] Supabase anon key:');
    expect(result.stdout).toContain('[entrypoint] Backend:');
    expect(result.stdout).toContain('[entrypoint] App URL:');
    expect(result.stdout).toContain('[entrypoint] Billing:');
    expect(result.stdout).not.toContain('[entrypoint] Backend host');
  });

  test('a placeholder the bundle does not contain is neither rewritten nor logged', () => {
    const bundle = makeBundle('const nothing = "baked";\n');
    const result = run(bundle, RUNTIME_ENV);
    expect(result.status).toBe(0);
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).toBe('const nothing = "baked";\n');
    expect(result.stdout).not.toContain('[entrypoint] Supabase');
    expect(result.stdout).not.toContain('[entrypoint] Backend:');
    expect(result.stdout).not.toContain('[entrypoint] App URL:');
    expect(result.stdout).toContain('[entrypoint] Billing: OFF (no rewrite needed)');
    expect(result.stdout).toContain('[entrypoint] No URL rewrites needed');
  });

  test('a runtime value equal to the baked one is left alone', () => {
    const bundle = makeBundle();
    const before = readFileSync(join(bundle, 'static/main.js'), 'utf8');
    const result = run(bundle, {
      NEXT_PUBLIC_SUPABASE_URL: BAKED.supabase,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: BAKED.anon,
      NEXT_PUBLIC_BACKEND_URL: BAKED.backend,
      NEXT_PUBLIC_APP_URL: BAKED.app,
      NEXT_PUBLIC_BILLING_ENABLED: 'true',
    });
    expect(result.status).toBe(0);
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).toBe(before);
    expect(result.stdout).not.toContain('[entrypoint] Supabase');
    expect(result.stdout).not.toContain('[entrypoint] Backend:');
    expect(result.stdout).not.toContain('[entrypoint] App URL:');
    expect(result.stdout).toContain('[entrypoint] Billing: ON (no rewrite needed)');
    expect(result.stdout).toContain('[entrypoint] No URL rewrites needed');
  });

  test('rewrites local Supabase CLI URLs, full before bare, and a baked sb_publishable key', () => {
    const bundle = makeBundle(
      [
        'const a = "http://127.0.0.1:54321/auth";',
        'const b = "ws://localhost:54321/realtime";',
        'const k = "sb_publishable_ABC-123";',
        '',
      ].join('\n'),
    );
    const result = run(bundle, RUNTIME_ENV);
    expect(result.status).toBe(0);
    expect(readFileSync(join(bundle, 'static/main.js'), 'utf8')).toBe(
      [
        `const a = "${RUNTIME.supabase}/auth";`,
        `const b = "ws://${RUNTIME.supabase}/realtime";`,
        `const k = "${RUNTIME.anon}";`,
        '',
      ].join('\n'),
    );
    expect(result.stdout).toContain(`[entrypoint] Supabase URL (dev): http://127.0.0.1:54321 -> ${RUNTIME.supabase}`);
    expect(result.stdout).toContain(`[entrypoint] Supabase URL (dev bare): 127.0.0.1:54321 -> ${RUNTIME.supabase}`);
    expect(result.stdout).toContain(`[entrypoint] Supabase URL (dev bare): localhost:54321 -> ${RUNTIME.supabase}`);
    expect(result.stdout).not.toContain('[entrypoint] Supabase URL (dev): http://localhost:54321');
    expect(result.stdout).toContain('[entrypoint] Supabase anon key: replacing (sb_publishable_ABC-123)');
    expect(result.stdout).not.toContain('[entrypoint] Supabase URL: ');
  });

  test('a trailing slash on the runtime backend URL is dropped from the rewritten URL and host', () => {
    const bundle = makeBundle();
    const result = run(bundle, { NEXT_PUBLIC_BACKEND_URL: 'https://api.real.com/v1/' });
    expect(result.status).toBe(0);
    const text = readFileSync(join(bundle, 'static/main.js'), 'utf8');
    expect(text).toContain('const backend = "https://api.real.com/v1";');
    expect(text).toContain('const backendHost = "https://api.real.com";');
    expect(result.stdout).toContain('[entrypoint] Backend: http://localhost:8008/v1 -> https://api.real.com/v1/');
  });
});
