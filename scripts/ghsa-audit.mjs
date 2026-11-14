#!/usr/bin/env node
// Fail on a moderate-or-worse GHSA advisory in the root pnpm-lock.yaml.
//
//   node scripts/ghsa-audit.mjs
//
// Runs `pnpm@8.11.0 audit --json` (the lockfile's pnpm) and filters its report:
// pnpm 8.11 cannot ignore an advisory by GHSA id. Used by the `GHSA lockfile
// advisory check` job in .github/workflows/ci.yml and by
// scripts/pre-promote-tripwires.sh. An unreadable report fails.
import { spawnSync } from 'node:child_process';

// Exception: 4 better-auth advisories. Only apps/white-label/lumen pulls
// better-auth; no workflow builds or deploys it; it uses none of the affected
// features (device login, OAuth proxy, magic link); and @convex-dev/better-auth
// has no release for the fixed better-auth 1.7.7+.
// Exception: GHSA-qr28-fpjm-wq7f (decode-uri-component <= 0.5.0, a DoS on a
// crafted percent-encoded string). Only apps/mobile pulls it, through
// expo-router -> query-string 7.1.3, to parse the app's own URLs on the device.
// The only fix, 0.5.1, is ESM-only, and query-string 7 loads it with require().
// Remove the exception when expo-router leaves query-string 7.
const IGNORE = new Set([
  'GHSA-q84f-53jg-9ppm',
  'GHSA-r4xp-prcw-77qf',
  'GHSA-965c-763c-88jm',
  'GHSA-44jh-23m7-hpcf',
  'GHSA-qr28-fpjm-wq7f',
]);
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

const run = spawnSync('npx', ['--yes', 'pnpm@8.11.0', 'audit', '--audit-level', 'moderate', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`pnpm audit gave no JSON report (exit ${run.status}):\n${run.stderr}`);
  process.exit(1);
}
const bad = Object.values(report.advisories ?? {}).filter(
  (a) => RANK[a.severity] >= RANK.moderate && !IGNORE.has(a.github_advisory_id),
);
for (const a of bad) console.log(`${a.severity} ${a.module_name} ${a.github_advisory_id} ${a.url}`);
process.exit(bad.length ? 1 : 0);
