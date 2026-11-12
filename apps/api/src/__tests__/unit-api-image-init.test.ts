import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// From 2026-11-03 the prod worker aborted every ~90 min ("Bun has crashed",
// WTF::Thread::create). Bun ran as PID 1 and never reaped the auto-maintenance
// that git detaches after a fetch or a commit: zombies took every PID.
test('the API image runs every command under tini, which reaps orphaned processes', () => {
  const dockerfile = readFileSync(resolve(import.meta.dir, '../../Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

  expect(runtime).toMatch(/apt-get install[^&]*\btini\b/);
  const entrypoints = [...runtime.matchAll(/^ENTRYPOINT (.+)$/gm)].map((match) => JSON.parse(match[1]!));
  expect(entrypoints).toEqual([['/usr/bin/tini', '-s', '--', '/usr/local/bin/docker-entrypoint.sh']]);
});
