// The pinned gitleaks binary for everything that scans at the CI ruleset
// (scripts/gitleaks-allowlist.test.mjs, tests/unit/gitleaks-ignore.test.ts).
//
// The exact build .github/workflows/secret-scan.yml installs. An assertion
// always scans with THIS version: another release ships other rules, and a
// config test that silently ran on a different binary would prove nothing.
// When PATH has no gitleaks (CI lanes, a fresh laptop) the release is
// downloaded once into ~/.cache/kortix/gitleaks and reused after that.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = '8.30.1';

let resolved;
export function pinnedGitleaks() {
  if (resolved) return resolved;
  const cached = join(homedir(), '.cache', 'kortix', 'gitleaks', PIN, 'gitleaks');
  if (existsSync(cached)) {
    resolved = cached;
    return cached;
  }
  const base = `https://github.com/gitleaks/gitleaks/releases/download/v${PIN}`;
  const archive = `gitleaks_${PIN}_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-download-'));
  const fail = (message) => {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(message);
  };
  // CWE-494, as secret-scan.yml does it: fetch the published checksum for THIS
  // archive and refuse a mismatch before the downloaded binary ever runs.
  // --retry: GitHub release downloads answer a transient 504 (2026-11-09
  // nightly); curl retries 408/429/5xx and timeouts.
  execFileSync('curl', [
    '-sSfL',
    '--retry',
    '3',
    `${base}/gitleaks_${PIN}_checksums.txt`,
    '-o',
    join(dir, 'checksums.txt'),
  ]);
  const expected = readFileSync(join(dir, 'checksums.txt'), 'utf8')
    .split('\n')
    .find((line) => line.endsWith(` ${archive}`))
    ?.split(' ')[0];
  if (!expected) fail(`${archive} is missing from the published checksums.txt`);
  execFileSync('curl', ['-sSfL', '--retry', '3', `${base}/${archive}`, '-o', join(dir, archive)]);
  const actual = createHash('sha256')
    .update(readFileSync(join(dir, archive)))
    .digest('hex');
  if (actual !== expected) fail(`${archive} does not match its published sha256`);
  execFileSync('tar', ['-xzf', join(dir, archive), '-C', dir, 'gitleaks']);
  mkdirSync(join(cached, '..'), { recursive: true });
  copyFileSync(join(dir, 'gitleaks'), cached);
  chmodSync(cached, 0o755);
  rmSync(dir, { recursive: true, force: true });
  resolved = cached;
  return cached;
}
