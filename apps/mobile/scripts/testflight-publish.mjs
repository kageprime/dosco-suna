#!/usr/bin/env node
// Uploads an iOS build to TestFlight with the production API. Never calls the
// public store-release script, App Review, or Google Play.
// node apps/mobile/scripts/testflight-publish.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'prod-testflight';
const BACKEND = 'https://api.kortix.com/v1';
const eas = (args) => execFileSync('eas', args, {
  cwd: MOBILE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26,
});

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--dry-run')) {
    throw new Error('usage: testflight-publish.mjs [--dry-run]');
  }
  const { buildProfile } = JSON.parse(eas(['config', '--platform', 'ios', '--profile', PROFILE, '--json', '--non-interactive']));
  if (buildProfile.environment !== 'production' || buildProfile.channel !== 'testflight-production' || buildProfile.distribution !== 'store') {
    throw new Error('prod-testflight must use the production environment, testflight-production channel, and store distribution');
  }
  const backend = eas(['env:get', 'production', '--variable-name', 'EXPO_PUBLIC_BACKEND_URL', '--format', 'short', '--non-interactive'])
    .match(/EXPO_PUBLIC_BACKEND_URL=(\S+)/)?.[1]?.replace(/\/$/, '');
  if (backend !== BACKEND || (buildProfile.env?.EXPO_PUBLIC_BACKEND_URL && buildProfile.env.EXPO_PUBLIC_BACKEND_URL.replace(/\/$/, '') !== BACKEND)) {
    throw new Error(`TestFlight requires the production API ${BACKEND}`);
  }
  const health = await fetch(`${BACKEND}/health`, { signal: AbortSignal.timeout(15_000) });
  if (!health.ok || (await health.json()).environment !== 'prod') throw new Error('production API health check failed');
  console.log(`TestFlight only: iOS, profile ${PROFILE}, API ${BACKEND}, channel testflight-production`);
  if (args[0] === '--dry-run') {
    console.log('Dry run: would build iOS and submit that build to TestFlight. No build or submission started.');
    return;
  }
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: join(MOBILE, '../..'), encoding: 'utf8' }).trim();
  if (dirty) throw new Error('commit all changes before building for TestFlight');
  const [build] = JSON.parse(eas(['build', '--platform', 'ios', '--profile', PROFILE, '--wait', '--json', '--non-interactive']));
  if (!build?.id || build.platform !== 'IOS' || build.status !== 'FINISHED') throw new Error('EAS returned no finished iOS build; nothing submitted');
  console.log(`Built iOS: ${build.id}`);
  // EAS Submit uploads to TestFlight. App Review requires a separate operation,
  // implemented only by store-release.mjs, which this path never invokes.
  eas(['submit', '--platform', 'ios', '--profile', PROFILE, '--id', build.id, '--non-interactive', '--wait']);
  console.log(`Uploaded ${build.id} to TestFlight. Apple processing and tester-group access determine when testers can install it.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
