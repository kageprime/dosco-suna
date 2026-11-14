#!/usr/bin/env node
// Sets the app version in every file a native build or EAS Update reads it from.
//
//   node apps/mobile/scripts/set-version.mjs --next
//   node apps/mobile/scripts/set-version.mjs 1.4.4  # explicit release only
//
// Agents bump once per mobile task. EAS increments the build number on every
// build. runtimeVersion follows the version: an OTA update only reaches
// binaries built from the same release. `ios/` and
// `android/` are committed (no prebuild), so app.json alone changes nothing in
// a build: each native copy is written here too.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..');

// [file, pattern]: group 1 is the text in front of the version, group 2 the version.
/** @type {Array<[string, RegExp]>} */
export const VERSION_SITES = [
  ['app.json', /("version": ")([^"]+)/g],
  ['app.json', /("runtimeVersion": ")([^"]+)/g],
  ['ios/Kortix/Info.plist', /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]+)/g],
  ['ios/Kortix/Supporting/Expo.plist', /(<key>EXUpdatesRuntimeVersion<\/key>\s*<string>)([^<]+)/g],
  // Not MARKETING_VERSION in project.pbxproj: Info.plist holds the literal, so
  // that build setting never reaches the app.
  ['android/app/build.gradle', /(versionName ")([^"]+)/g],
  ['android/app/src/main/res/values/strings.xml', /(<string name="expo_runtime_version">)([^<]+)/g],
];

export function readVersions(root = MOBILE) {
  return VERSION_SITES.flatMap(([file, re]) => {
    const matches = [...readFileSync(join(root, file), 'utf8').matchAll(re)];
    if (!matches.length) throw new Error(`version field missing in ${file}`);
    return matches.map((m) => ({ file, version: m[2] }));
  });
}

export function nextVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`expected MAJOR.MINOR.PATCH, got "${version}"`);
  const patch = BigInt(match[3]);
  // Enter the two-digit patch range once, then count up without carrying to minor.
  const next = patch === 0n ? 10n : patch < 10n ? patch * 10n + 1n : patch + 1n;
  return `${match[1]}.${match[2]}.${next}`;
}

export function bumpVersion(root = MOBILE) {
  const versions = new Set(readVersions(root).map(({ version }) => version));
  if (versions.size !== 1) throw new Error('mobile version copies disagree; synchronize them before --next');
  setVersion(nextVersion([...versions][0]), root);
}

export function setVersion(version, root = MOBILE) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`expected MAJOR.MINOR.PATCH, got "${version}"`);
  for (const [file, re] of VERSION_SITES) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(re, `$1${version}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  if (process.argv[2] === '--next') bumpVersion();
  else setVersion(process.argv[2]);
  for (const { file, version } of readVersions()) console.log(`${version}  ${file}`);
}
