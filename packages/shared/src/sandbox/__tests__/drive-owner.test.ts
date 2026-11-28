import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { KORTIX_RUNTIME_UID } from '../defaults';

// The drive-owner helper is a Python heredoc in apps/sandbox/entrypoint.sh. A
// drive folder mounts read-write into several boxes at once, so its ownership
// rule decides whether two boxes re-own the same files forever. This runs the
// helper's own `wants` with python3, never a copy of it.
const entrypoint = readFileSync(resolve(import.meta.dir, '../../../../../apps/sandbox/entrypoint.sh'), 'utf8');
const helper = entrypoint.split("<<'KORTIX_DRIVE_OWNER_PY'\n")[1]?.split('\nKORTIX_DRIVE_OWNER_PY\n')[0] ?? '';

type Case = [owner: number, runtime: number, attribOnly: boolean];

function wants(cases: Case[]): boolean[] {
  // Loaded under another __name__, so the helper's main loop does not start.
  const run = Bun.spawnSync([
    'python3',
    '-I',
    '-c',
    'import json, sys; ns = {"__name__": "drive_owner"}; exec(sys.argv[1], ns); ' +
      'print(json.dumps([ns["wants"](*c) for c in json.loads(sys.argv[2])]))',
    helper,
    JSON.stringify(cases),
  ]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

const CANONICAL = KORTIX_RUNTIME_UID;
const OLD = 1001;

describe('drive-owner helper', () => {
  test('pins the same canonical uid as the images', () => {
    expect(helper).toContain(`CANONICAL_UID = ${KORTIX_RUNTIME_UID}\n`);
  });

  test('root-owned entries go to the runtime user on any event, whatever its uid', () => {
    expect(wants([[0, CANONICAL, false], [0, CANONICAL, true], [0, OLD, false], [0, OLD, true]])).toEqual([true, true, true, true]);
  });

  test('an entry the runtime user owns stays as it is', () => {
    expect(wants([[CANONICAL, CANONICAL, false], [OLD, OLD, true]])).toEqual([false, false]);
  });

  test('a box at the canonical uid takes an older image\'s files on a walk or a new entry', () => {
    expect(wants([[OLD, CANONICAL, false], [1002, CANONICAL, false]])).toEqual([true, true]);
  });

  test('another box\'s chown is never undone, so no two boxes re-own a file back and forth', () => {
    // Box A at 1000 and box B at 1001 share a folder. B never takes A's files,
    // and A ignores B's attribute changes: the folder settles.
    expect(wants([[CANONICAL, OLD, false], [CANONICAL, OLD, true], [OLD, CANONICAL, true]])).toEqual([false, false, false]);
  });
});

function mounts(text: string): Record<string, string[]> {
  const run = Bun.spawnSync([
    'python3',
    '-I',
    '-c',
    'import json, sys; ns = {"__name__": "drive_owner"}; exec(sys.argv[1], ns); print(json.dumps(ns["parse_mountinfo"](sys.argv[2])))',
    helper,
    text,
  ]);
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  return JSON.parse(run.stdout.toString());
}

describe('drive-owner helper mounts', () => {
  const block = '41 30 0:52 / /drives/Files rw,relatime shared:1 - fuse.nodefs nodefs rw,user_id=0';
  const shared = '57 30 0:61 / /drives/Files rw,relatime shared:9 - fuse.sharedfs sfs rw,user_id=0';

  test('only read-write mounts under /drives, keyed by path', () => {
    const text = [
      block,
      '42 30 0:53 / /drives/Read\\040only ro,relatime - fuse.nodefs nodefs ro',
      '43 1 259:1 / /workspace rw,relatime - ext4 /dev/vdb rw',
      '44 30 0:54 / /drives/With\\040space rw,relatime - fuse.nodefs nodefs rw',
    ].join('\n');
    expect(Object.keys(mounts(text)).sort()).toEqual(['/drives/Files', '/drives/With space']);
  });

  test('a new volume at the same path (a live switch) is a new mount, so it is walked again', () => {
    const before = mounts(block)['/drives/Files'];
    const after = mounts(shared)['/drives/Files'];
    expect(before).toBeDefined();
    expect(after).not.toEqual(before);
    // The same mount read twice is the same: no walk on every pass.
    expect(mounts(block)['/drives/Files']).toEqual(before);
  });
});
