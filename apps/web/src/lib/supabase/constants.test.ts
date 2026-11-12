import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// Regression (KRTX-4628): the deployed browser bundle inlines the BUILD-time
// NEXT_PUBLIC_* placeholders (the release build runs with
// `NEXT_PUBLIC_APP_URL=http://localhost:3000`), so resolving the auth cookie
// name from process.env made the BROWSER compute `sb-kortix-auth-token-3000`
// while the SERVER (runtime env, https://dev.kortix.com) computed
// `sb-kortix-auth-token`. The PKCE verifier cookie the auth page seeded after
// a send therefore never matched the name /auth/callback read: the exchange
// threw AuthPKCECodeVerifierMissingError, the visitor bounced through
// /auth?pkce_code=… to /auth?expired=true, and a brand-new signup could never
// confirm its address from the mail. The name must resolve through the
// runtime env reader (window.__KORTIX_RUNTIME_CONFIG in the browser), which
// both sides agree on.

const webRoot = join(import.meta.dir, '..', '..', '..');

function runInEnv(script: string, env: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ['bun', '-e', script],
    cwd: webRoot,
    env,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

// The deployed build env (deploy-dev.yml "Build frontend standalone output"):
// NEXT_PUBLIC_* placeholders from the build host, no KORTIX_PUBLIC_*.
const BUILD_ENV: Record<string, string> = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'https://placeholder.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-build-placeholder-anon-key',
  NEXT_PUBLIC_BACKEND_URL: 'http://localhost:8008/v1',
};

const runtimeConfigFor = (appUrl: string) => ({
  // The SSR runtime script (`window.__KORTIX_RUNTIME_CONFIG`) carries the
  // deployment's real public env, never the build placeholders.
  APP_URL: appUrl,
  SUPABASE_URL: 'https://real-project.supabase.co',
  SUPABASE_ANON_KEY: 'real-anon-key',
  BACKEND_URL: 'https://dev-api.kortix.com/v1',
});

describe('KORTIX_SUPABASE_AUTH_COOKIE resolves the same name on both sides of the deploy', () => {
  test('browser: the runtime script wins over the inlined build placeholder', () => {
    const script = `
      globalThis.window = {
        __KORTIX_RUNTIME_CONFIG: ${JSON.stringify(runtimeConfigFor('https://dev.kortix.com'))},
      };
      const { KORTIX_SUPABASE_AUTH_COOKIE } = await import('./src/lib/supabase/constants.ts');
      console.log(KORTIX_SUPABASE_AUTH_COOKIE);
    `;
    const run = runInEnv(script, { ...process.env, ...BUILD_ENV } as Record<string, string>);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split("\n").pop()).toBe('sb-kortix-auth-token');
  });

  test('browser: a localhost runtime APP_URL keeps the port-scoped name', () => {
    const script = `
      globalThis.window = {
        __KORTIX_RUNTIME_CONFIG: ${JSON.stringify(runtimeConfigFor('http://localhost:13000'))},
      };
      const { KORTIX_SUPABASE_AUTH_COOKIE } = await import('./src/lib/supabase/constants.ts');
      console.log(KORTIX_SUPABASE_AUTH_COOKIE);
    `;
    const run = runInEnv(script, { ...process.env, ...BUILD_ENV } as Record<string, string>);
    expect(run.stderr).toBe('');
    // Two local frontends on one browser (localhost:3000 + a worktree :13000)
    // keep their sessions separate — the reason the port suffix exists.
    expect(run.stdout.trim().split("\n").pop()).toBe('sb-kortix-auth-token-13000');
  });

  test('server: no window, runtime env decides (the worktree dev server)', () => {
    const script = `
      const { KORTIX_SUPABASE_AUTH_COOKIE } = await import('./src/lib/supabase/constants.ts');
      console.log(KORTIX_SUPABASE_AUTH_COOKIE);
    `;
    const run = runInEnv(script, {
      ...process.env,
      ...BUILD_ENV,
      KORTIX_PUBLIC_APP_URL: 'http://localhost:13000',
    } as Record<string, string>);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split("\n").pop()).toBe('sb-kortix-auth-token-13000');
  });

  test('server: a deployed APP_URL (no port) keeps the historical name', () => {
    const script = `
      const { KORTIX_SUPABASE_AUTH_COOKIE } = await import('./src/lib/supabase/constants.ts');
      console.log(KORTIX_SUPABASE_AUTH_COOKIE);
    `;
    const run = runInEnv(script, {
      ...process.env,
      ...BUILD_ENV,
      KORTIX_PUBLIC_APP_URL: 'https://dev.kortix.com',
    } as Record<string, string>);
    expect(run.stderr).toBe('');
    expect(run.stdout.trim().split("\n").pop()).toBe('sb-kortix-auth-token');
  });

  test('importing the module never throws when required runtime env is absent', () => {
    const script = `
      const { KORTIX_SUPABASE_AUTH_COOKIE } = await import('./src/lib/supabase/constants.ts');
      console.log(typeof KORTIX_SUPABASE_AUTH_COOKIE === 'string' && KORTIX_SUPABASE_AUTH_COOKIE.length > 0);
    `;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    // Strip every env var the module (or getEnv) reads.
    for (const key of Object.keys(env)) {
      if (/^(KORTIX_PUBLIC|NEXT_PUBLIC)_(APP_URL|URL|SUPABASE|BACKEND)/.test(key) || key === 'PUBLIC_URL') delete env[key];
    }
    const run = runInEnv(script, env);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim().split("\n").pop()).toBe('true');
  });
});
