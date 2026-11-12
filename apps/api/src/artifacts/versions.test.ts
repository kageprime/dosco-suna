import { expect, test } from 'bun:test';
import { entrySaves } from './versions';

// One publish writes the entry once (root-owned); a box that mounts the
// folder then re-owns it, which is a new commit with the same size and mtime.
const publish = { commit: 'c1', stat: { size: 120, mtime: 1_000 } };
const chown = { commit: 'c2', stat: { size: 120, mtime: 1_000 } };

test('a publish is one version, also when a box re-owns the file after it', () => {
  expect(entrySaves([publish])).toEqual(['c1']);
  expect(entrySaves([publish, chown])).toEqual(['c1']);
});

test('a re-publish is exactly one more version; commits that leave the entry alone are none', () => {
  const other = { commit: 'c3', stat: { size: 120, mtime: 1_000 } }; // a write elsewhere in Files
  const save = { commit: 'c4', stat: { size: 120, mtime: 2_000 } }; // same bytes saved again
  const resize = { commit: 'c5', stat: { size: 140, mtime: 3_000 } };
  expect(entrySaves([publish, chown, other, save, resize])).toEqual(['c1', 'c4', 'c5']);
});

test('commits before the file existed, or after it was gone, are no version', () => {
  const absent = { commit: 'c0', stat: null };
  const back = { commit: 'c6', stat: { size: 120, mtime: 1_000 } };
  expect(entrySaves([absent, publish, { commit: 'c5', stat: null }, back])).toEqual(['c1']);
});
