// The repo's reviewed gitleaks false positives (`.gitleaksignore`) are the
// release gate's only legitimate path to a clean secret-scan, so the file
// itself is under test: its entries are the one thing standing between a
// flagged commit and a red release PR. Two checks:
//
// 1. Every fingerprint is well-formed (`commit:file:rule:line`), because a
//    silently mis-typed entry looks exactly like a clean scan — gitleaks
//    ignores unknown fingerprints without a warning.
// 2. The reviewed WS-AUTH-10 entry (KRTX-4583) actually suppresses its
//    finding: scanning just its flagged commit with the pinned CI binary and
//    this ignore file reports zero findings, while the same scan without the
//    entry reports the finding again. The scan runs against the real repo
//    history (the fingerprint is bound to the commit SHA, so a throwaway
//    fixture repo cannot express it).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { pinnedGitleaks } from '../../scripts/lib/gitleaks-binary.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const FINGERPRINT = /^([0-9a-f]{40}):(.+):([a-z0-9-]+):([0-9]+)$/;

const lines = readFileSync(join(ROOT, '.gitleaksignore'), 'utf8')
  .split('\n')
  .filter((line) => line.trim() && !line.trim().startsWith('#'));
const entries = lines
  .map((line) => line.match(FINGERPRINT))
  .filter((match): match is RegExpMatchArray => match !== null);
const minterEntry = entries.find((m) => m[2] === 'tests/src/flows/workspace-auth.flow.ts');

test('every .gitleaksignore entry is a fingerprint gitleaks can match', () => {
  expect(lines.length).toBeGreaterThan(0);
  expect(entries.length, `${lines.length - entries.length} unparseable fingerprint line(s)`).toBe(
    lines.length,
  );
  for (const m of entries) {
    expect(Number(m[4]), `1-based line number in ${m[0]}`).toBeGreaterThan(0);
  }
});

test('the reviewed WS-AUTH-10 minter label is suppressed by the pinned scanner', () => {
  if (!minterEntry)
    throw new Error('the reviewed KRTX-4583 fingerprint is missing from .gitleaksignore');
  expect(minterEntry[3], 'the flagging rule').toBe('generic-api-key');
  const commit = minterEntry[1];
  // CI checks out depth 1, so the flagged commit sits back in history: fetch
  // exactly it (full SHA; the fingerprint is bound to it). --depth=2 keeps the
  // parent, without which `git -p` on that one commit cannot render the diff.
  const haveCommit = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: ROOT });
  if (haveCommit.status !== 0) {
    execFileSync('git', ['fetch', '--quiet', '--no-tags', '--depth', '2', 'origin', commit], {
      cwd: ROOT,
    });
  }
  const gitleaks = pinnedGitleaks();
  const dir = mkdtempSync(join(tmpdir(), 'gitleaks-ignore-'));
  const report = join(dir, 'report.json');
  const run = spawnSync(
    gitleaks,
    [
      'git',
      // Only the flagged file of the flagged commit: the commit is the
      // workspaces rename (2,463 files), and scanning all of it took >30 s on
      // a CI runner (release run 42709749119). The fingerprint names the path.
      `--log-opts=-1 ${minterEntry[1]} -- ${minterEntry[2]}`,
      '--redact',
      '--exit-code',
      '1',
      '--report-format',
      'json',
      '--report-path',
      report,
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // gitleaks exits 1 when it reports findings and 0 when it does not; any
  // other status is an error (bad config, missing binary), never a verdict.
  expect([0, 1], `gitleaks failed: ${run.stderr}`).toContain(run.status);
  const findings = (
    JSON.parse(readFileSync(report, 'utf8')) as Array<{ File: string; StartLine: number }>
  ).map((f) => `${f.File}:${f.StartLine}`);
  rmSync(dir, { recursive: true, force: true });
  expect(
    findings,
    'the reviewed false positive stays suppressed on the real flagged commit',
  ).toEqual([]);
});
