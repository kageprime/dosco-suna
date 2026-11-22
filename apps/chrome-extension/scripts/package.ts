// Builds the Chrome Web Store upload: bun run package
// → release/kortix-chrome-<version>.zip: the store build (kortix.com only), without the manifest `key`.
// The store refuses a manifest with `key`; the item ID is already fixed in the store.
import { cpSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.KORTIX_EXTENSION_DEV === '1') {
  console.error('KORTIX_EXTENSION_DEV=1 makes a dev build. The store gets the kortix.com build only.');
  process.exit(1);
}

const app = join(import.meta.dir, '..');
const run = (cmd: string[], cwd = app) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};

run(['bun', 'run', 'scripts/build.ts']);

const manifest = JSON.parse(readFileSync(join(app, 'dist/manifest.json'), 'utf8'));
delete manifest.key;
const name = `kortix-chrome-${manifest.version}`;
const stage = join(app, 'release', name);
const zip = join(app, 'release', `${name}.zip`);
rmSync(stage, { recursive: true, force: true });
rmSync(zip, { force: true });
cpSync(join(app, 'dist'), stage, { recursive: true });
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
run(['zip', '-r', '-X', '-q', zip, '.'], stage);

console.log(`\n${zip}\nversion ${manifest.version}, ${Math.round(statSync(zip).size / 1024)} KB, no key`);
console.log('Upload it in the Chrome Web Store dashboard: Package → Upload new package.');
console.log('The store accepts only a version higher than the last upload: raise "version" in src/manifest.json first.');
