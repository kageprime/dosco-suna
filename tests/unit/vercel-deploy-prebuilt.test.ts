import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { REPO_ROOT as root } from '../src/fixtures/repo';

const script = resolve(root, 'infra/scripts/vercel-deploy-prebuilt.sh');
const URL = 'https://suna-abc123-kortixai.vercel.app';

/**
 * Drives the REAL infra/scripts/vercel-deploy-prebuilt.sh with a stub Vercel
 * CLI (VERCEL_CLI). The stub logs every call, writes the env file `vercel pull`
 * writes, and records what `vercel build` sees, so each case asserts what the
 * script hands to the build and to the upload.
 */
const CLI_STUB = String.raw`#!/usr/bin/env bash
# No -u: a case without --build-env leaves OVERRIDE unset.
set -eo pipefail
cmd="$1"; shift
printf '%s %s\n' "$cmd" "$*" >>"$STUB_DIR/calls.log"
case "$cmd" in
  pull)
    env_name="$(printf '%s\n' "$@" | sed -n 's/^--environment=//p')"
    mkdir -p .vercel
    # What vercel 65.14.0 writes for a Sensitive variable it cannot read.
    printf 'KEEP="project"\nOVERRIDE="project"\nHIDDEN_FLAG="[SENSITIVE]"\n' >".vercel/.env.$env_name.local"
    echo "pulled $env_name" ;;
  build)
    {
      echo "VERCEL=$VERCEL"
      echo "NEXT_ENABLE_ADAPTER=$NEXT_ENABLE_ADAPTER"
      echo "VERCEL_IMMUTABLE_STATIC_FILES_ENABLED=$VERCEL_IMMUTABLE_STATIC_FILES_ENABLED"
      echo "OVERRIDE=$OVERRIDE"
      echo "DEPLOYMENT_ID=$KORTIX_VERCEL_DEPLOYMENT_ID"
      cat .vercel/.env.*.local
    } >"$STUB_DIR/build.env"
    echo "built" ;;
  deploy)
    echo "Uploading [====] 10 MB"
    echo "${URL}" ;;
esac
`;

function run(args: string[], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vercel-prebuilt-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, 'vercel-stub.sh');
  writeFileSync(stub, CLI_STUB);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  const result = spawnSync('bash', [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      STUB_DIR: dir,
      VERCEL_CLI: `bash ${stub}`,
      VERCEL_TOKEN: 'token',
      VERCEL_ORG_ID: 'team_x',
      VERCEL_PROJECT_ID: 'prj_x',
      GITHUB_RUN_ID: '42425195629',
      GITHUB_RUN_ATTEMPT: '2',
      ...env,
    },
  });
  const read = (name: string) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return '';
    }
  };
  return { ...result, sha, calls: read('calls.log').trim().split('\n'), buildEnv: read('build.env') };
}

describe('vercel-deploy-prebuilt.sh', () => {
  it('builds a preview here, uploads it prebuilt, and prints only the URL', () => {
    const r = run(['preview', '--env', 'RUNTIME_ONLY=1', '--build-env', 'OVERRIDE=build']);

    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${URL}\n`);
    expect(r.calls[0]).toBe('pull --yes --environment=preview --token=token');
    expect(r.calls[1]).toBe('build --yes --token=token');
    expect(r.calls[2]).toBe(
      'deploy --prebuilt --archive=tgz --yes --token=token --env RUNTIME_ONLY=1',
    );
    // A --build-env value wins over the pulled project value, in the shell and
    // in the env file, and the other project values stay.
    expect(r.buildEnv).toContain('OVERRIDE=build\n');
    expect(r.buildEnv).toContain('KEEP="project"');
    expect(r.buildEnv).toContain('OVERRIDE="build"');
    expect(r.buildEnv).not.toContain('OVERRIDE="project"');
    // The build must not inline the "[SENSITIVE]" placeholder as a value.
    expect(r.buildEnv).not.toContain('HIDDEN_FLAG');
    expect(r.stderr).toContain('the build does not get (the runtime does): HIDDEN_FLAG');
    // What a build on Vercel gets from the platform: VERCEL=1 bakes the
    // runtime config, and a unique deployment ID keeps Skew Protection.
    expect(r.buildEnv).toContain('VERCEL=1\n');
    // The flags Vercel's build machines set: the Next adapter, and scripts on
    // /_next/static/immutable/ so their URLs survive a deploy.
    expect(r.buildEnv).toContain('NEXT_ENABLE_ADAPTER=1\n');
    expect(r.buildEnv).toContain('VERCEL_IMMUTABLE_STATIC_FILES_ENABLED=1\n');
    const id = /DEPLOYMENT_ID=(\S+)/.exec(r.buildEnv)?.[1] ?? '';
    expect(id).toBe(`k${r.sha.slice(0, 12)}-42425195629-2`);
    expect(id.length).toBeLessThanOrEqual(32);
  });

  it('builds and deploys production with --prod', () => {
    const r = run(['production', '--env', 'KORTIX_PUBLIC_VERSION=1.2.3']);

    expect(r.status).toBe(0);
    expect(r.calls[0]).toBe('pull --yes --environment=production --token=token');
    expect(r.calls[1]).toBe('build --prod --yes --token=token');
    expect(r.calls[2]).toBe(
      'deploy --prebuilt --archive=tgz --yes --prod --token=token --env KORTIX_PUBLIC_VERSION=1.2.3',
    );
  });

  it('refuses a build value it cannot write to the env file, before any build', () => {
    const r = run(['preview', '--build-env', 'OVERRIDE=a"b']);

    expect(r.status).toBe(2);
    expect(r.calls).toEqual(['pull --yes --environment=preview --token=token']);
  });

  it('refuses an unknown target and a missing token', () => {
    expect(run(['staging']).status).toBe(2);
    const noToken = run(['preview'], { VERCEL_TOKEN: '' });
    expect(noToken.status).not.toBe(0);
    expect(noToken.stderr).toContain('VERCEL_TOKEN is required');
  });
});
