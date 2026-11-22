import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';

import { createDriveChipSync, driveChipsIn, driveUploadName, driveUploadsOf, drivePathsIn, withoutDriveChips } from './drive-mentions';
import type { AttachedFile } from './types';

const chip = (kind: string, label: string, value: string): JSONContent => ({ type: 'mention', attrs: { kind, label, value } });
const doc = (...inline: JSONContent[]): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph', content: inline }] });

const draft = doc(
  chip('drive', 'a.png', '/Company/a.png'),
  { type: 'text', text: ' and ' },
  chip('drive', 'a.png', '/Users/ana/a.png'),
  chip('file', 'a.png', 'a.png'),
  chip('agent', 'build', 'build'),
);

describe('Drive chips in the composer document', () => {
  test('drivePathsIn names each Drive path once, and only Drive chips; driveChipsIn adds the name to fetch it by', () => {
    expect([...drivePathsIn(draft)]).toEqual(['/Company/a.png', '/Users/ana/a.png']);
    expect(drivePathsIn(null).size).toBe(0);
    expect([...driveChipsIn(doc(chip('drive', 'a.png', '/Company/a.png'), chip('drive', 'a.png', '/Company/a.png')))]).toEqual([
      ['/Company/a.png', 'a.png'],
    ]);
  });

  test('withoutDriveChips takes back only the chips of that path', () => {
    expect(withoutDriveChips(draft, '/Company/a.png')).toEqual(
      doc(
        { type: 'text', text: ' and ' },
        chip('drive', 'a.png', '/Users/ana/a.png'),
        chip('file', 'a.png', 'a.png'),
        chip('agent', 'build', 'build'),
      ),
    );
  });

  test('driveUploadName keeps the name unless the tray holds it; then the folder tells the two apart', () => {
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['a.txt'])).toBe('logo.png');
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['logo.png'])).toBe('logo (brand).png');
    expect(driveUploadName('logo.png', '/Company/brand/logo.png', ['logo.png', 'logo (brand).png'])).toBe('logo (brand 2).png');
    expect(driveUploadName('README', '/README', ['README'])).toBe('README (Drive)');
  });

  test('driveUploadsOf lists only the tray files staged from Drive, with their upload names', () => {
    const file = new File(['x'], 'logo (brand).png');
    expect(
      driveUploadsOf([
        { kind: 'local', file, localUrl: 'blob:1', isImage: true, drivePath: '/Company/brand/logo.png' },
        { kind: 'local', file: new File(['y'], 'mine.txt'), localUrl: 'blob:2', isImage: false },
        { kind: 'uploaded', uploadId: 'u1', filename: 'a b.png', mime: 'image/png', size: 3, isImage: false, drivePath: '/a b.png' },
        { kind: 'remote', url: 'https://x', filename: 'r.png', mime: 'image/png', isImage: true },
      ]),
    ).toEqual([
      { name: 'logo (brand).png', drivePath: '/Company/brand/logo.png' },
      { name: 'a b.png', drivePath: '/a b.png' },
    ]);
  });
});

describe('the tray follows the Drive chips', () => {
  const report = chip('drive', 'report.pdf', '/Company/report.pdf');
  const withReport = doc({ type: 'text', text: 'see ' }, report);
  const without = doc({ type: 'text', text: 'see ' });
  const driveUpload: AttachedFile = {
    kind: 'uploaded',
    uploadId: 'u-1',
    filename: 'report.pdf',
    mime: 'application/pdf',
    size: 10,
    isImage: false,
    drivePath: '/Company/report.pdf',
  };
  const setup = (tray: AttachedFile[], locked = false) => {
    const refetched: { path: string; name: string }[] = [];
    const sync = createDriveChipSync({
      tray: () => tray,
      remove: (index) => void tray.splice(index, 1),
      refetch: (file) => void refetched.push(file),
      paused: () => locked,
    });
    // Each change settles in a microtask, as it does in the composer.
    const change = async (next: JSONContent, recalling = false) => {
      sync.onDoc(next, recalling);
      await Promise.resolve();
    };
    return { sync, change, refetched };
  };

  test('a restored Drive chip that is deleted and undone fetches its file again, though this composer never picked it', async () => {
    // A reload restored the draft: its chip and its finished Drive upload.
    const tray: AttachedFile[] = [driveUpload];
    const { change, refetched } = setup(tray);
    await change(withReport);
    await change(without);
    expect(tray).toEqual([]);
    await change(withReport);
    expect(refetched).toEqual([{ path: '/Company/report.pdf', name: 'report.pdf' }]);
  });

  test('a picked chip that comes back without its file fetches it; a pasted chip never reads a file', async () => {
    const picked = setup([]);
    picked.sync.trust('/Company/report.pdf');
    await picked.change(withReport);
    expect(picked.refetched).toEqual([{ path: '/Company/report.pdf', name: 'report.pdf' }]);

    const pasted = setup([]);
    await pasted.change(withReport);
    await pasted.change(without);
    await pasted.change(withReport);
    expect(pasted.refetched).toEqual([]);
  });

  test('a recalled prompt and a question lock leave the tray alone', async () => {
    const tray: AttachedFile[] = [driveUpload];
    const recalled = setup(tray);
    await recalled.change(withReport);
    await recalled.change(without, true);
    expect(tray).toEqual([driveUpload]);

    const locked = setup(tray, true);
    await locked.change(withReport);
    await locked.change(without);
    expect(tray).toEqual([driveUpload]);
  });
});
