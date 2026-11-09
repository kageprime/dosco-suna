import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/fixtures/repo';

// The script probes the GitHub releases endpoint itself (prints the HTTP
// status, so a runner egress timeout is not mislabeled as a missing tag), then
// installs the pinned binary through the checksum-verifying upstream installer.

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const RELEASES_URL = 'github.com/aquasecurity/trivy/releases';

/**
 * One temp root with the script's target dir. With a mode, a curl stub goes
 * first on PATH: it answers github.com release calls per mode without touching
 * the network, logs every call, and passes the rest to the next real curl.
 */
function setup(mode?: 'timeout' | '404' | '200' | 'stall') {
  const root = mkdtempSync(join(tmpdir(), 'trivy-install-'));
  roots.push(root);
  let calls: () => string[] = () => [];
  let allCalls: () => string[] = () => [];
  const env = { ...process.env };
  if (mode) {
    const log = join(root, 'calls.log');
    const stub = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `mode="${mode}" log="${log}"`,
      'url="${*: -1}"; out=""; prev=""',
      'for a in "$@"; do',
      '  case "$prev" in -o|--output) out="$a"; prev=""; continue ;; esac',
      '  case "$a" in -o|--output) prev="$a" ;; esac',
      'done',
      'echo "curl $*" >> "$log"',
      'case "$url" in',
      `  *${RELEASES_URL}*)`,
      '    case "$mode" in',
      '      timeout) echo "000"; exit 28 ;;',
      '      stall) echo "200"; exit 28 ;;',
      '      404) if [ -n "$out" ] && [ "$out" != /dev/null ]; then printf "Not Found" > "$out"; fi; echo "404"; exit 0 ;;',
      '      200) if [ -n "$out" ] && [ "$out" != /dev/null ]; then printf \'{"tag_name":"v0.70.0"}\' > "$out"; fi; echo "200"; exit 0 ;;',
      '    esac ;;',
      '  *)',
      '    if [ "$mode" = 200 ]; then if [ -n "$out" ]; then printf "#!/bin/sh\\n" > "$out"; fi; exit 0; fi',
      '    if [ "$mode" = stall ]; then echo "download sentinel: a stalled probe must never reach the installer" >&2; exit 99; fi',
      '    exec "$(PATH="${PATH#*:}" command -v curl)" "$@" ;;',
      'esac',
      'echo "fake curl: unexpected call: $*" >&2',
      'exit 1',
    ].join('\n');
    writeFileSync(join(root, 'curl'), stub, { mode: 0o755 });
    env.PATH = `${root}:${process.env.PATH}`;
    env.CALL_LOG = log;
    calls = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line.includes(RELEASES_URL));
    allCalls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  }
  const run = () =>
    spawnSync('bash', [join(REPO_ROOT, 'infra/scripts/install-trivy.sh'), join(root, 'bin')], {
      encoding: 'utf8',
      env,
    });
  return { run, calls, allCalls };
}

it('installs the pinned binary through the real checksum-verifying upstream installer', () => {
  const { run } = setup();
  const bin = join(roots[0], 'bin');
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('HTTP 200');
  expect(execFileSync(join(bin, 'trivy'), ['--version'], { encoding: 'utf8' })).toContain(
    'Version: 0.70.0',
  );
}, 240_000);

it('fails closed when the downloaded installer checksum does not match', () => {
  const root = mkdtempSync(join(tmpdir(), 'trivy-tamper-'));
  roots.push(root);
  mkdirSync(join(root, 'tools'));
  // Only replace the HTTP boundary; the installation script and hash check are
  // real. --write-out answers the script's releases probe with 200, --output
  // serves the tampered installer body.
  writeFileSync(
    join(root, 'tools/curl'),
    '#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do\n if [[ "$1" == --write-out ]]; then printf "200"; exit 0; fi\n if [[ "$1" == --output ]]; then printf "exit 0\\n" > "$2"; exit 0; fi\n shift\ndone\nexit 1\n',
    { mode: 0o755 },
  );
  const result = spawnSync(
    'bash',
    [join(REPO_ROOT, 'infra/scripts/install-trivy.sh'), join(root, 'bin')],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(root, 'tools')}:${process.env.PATH}` },
    },
  );
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain('FAILED');
});

it('when github.com times out, fails bounded with the HTTP status and never reports the missing-tag lie', () => {
  const { run, calls } = setup('timeout');
  const result = run();
  const out = result.stdout + result.stderr;

  expect(result.status).not.toBe(0);
  expect(out).toContain('HTTP 000');
  expect(out).toContain('curl exit 28');
  expect(out).not.toContain('unable to find');
  expect(calls()).toHaveLength(3);
  for (const line of calls()) {
    expect(line).toMatch(/--max-time/);
    expect(Number((line.match(/--max-time (\d+)/) ?? [])[1])).toBeLessThanOrEqual(60);
  }
});

it('when GitHub answers 404, prints the HTTP status instead of the missing-tag lie', () => {
  const { run } = setup('404');
  const result = run();
  const out = result.stdout + result.stderr;

  expect(result.status).not.toBe(0);
  expect(out).toContain('HTTP 404');
  expect(out).not.toContain('unable to find');
});

it('when GitHub answers 200, the flow proceeds past the probe to the pinned-installer checksum', () => {
  const { run } = setup('200');
  const result = run();
  const out = result.stdout + result.stderr;

  expect(out).toContain('HTTP 200');
  expect(out).not.toContain('unable to find');
  // The stub's fake installer body fails the pinned sha256 check: proof the
  // flow reached the checksum step, the step right after the probe.
  expect(out).toContain('FAILED');
});

it('when the body stalls after 200 headers (curl exit 28), the probe fails and never reaches the installer', () => {
  const { run, calls, allCalls } = setup('stall');
  const result = run();
  const out = result.stdout + result.stderr;

  // --write-out still prints 200 when the body stalls after the headers, so
  // the diagnostic carries the real status AND the curl failure.
  expect(out).toContain('HTTP 200');
  expect(out).toContain('curl exit 28');
  // The success line never prints: an HTTP 200 with a curl failure is a
  // stalled response, not a completed probe.
  expect(out).not.toContain('probe: HTTP 200');
  expect(out).not.toContain('unable to find');
  expect(calls()).toHaveLength(3);
  // Exactly 3 curl calls: only the 3 probes. A 4th call would be the installer
  // download, which the stub answers with the exit-99 download sentinel.
  expect(allCalls()).toHaveLength(3);
});
