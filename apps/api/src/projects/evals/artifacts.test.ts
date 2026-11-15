import { describe, expect, test } from 'bun:test';
import { artifactEntries, artifactFiles, hostDestination, sanitizedFileMode, sanitizeTree, sourcePath, tarExcluded, type CollectedArtifact } from './artifacts';

const entry = (type: string, path: string, mode = 0o644, target = '') => ({ type, mode, size: 1, path, target });

describe('artifact entries and paths', () => {
  test('/logs/artifacts is collected first, unless the task declares it', () => {
    expect(artifactEntries({ artifacts: [{ source: '/app/r.json', destination: null, exclude: [] }] }).map((a) => a.source)).toEqual(['/logs/artifacts', '/app/r.json']);
    expect(artifactEntries({ artifacts: [{ source: '/logs/artifacts/', destination: null, exclude: ['*.tmp'] }] })).toHaveLength(1);
  });
  test('a source mirrors under artifacts/ unless it names a destination; a relative source is below the workdir', () => {
    expect(hostDestination({ source: '/app/report.json', destination: null, exclude: [] }, '/app/report.json')).toBe('app/report.json');
    expect(hostDestination({ source: '/app/out', destination: 'out', exclude: [] }, '/app/out')).toBe('out');
    expect(sourcePath('out/x', '/app')).toBe('/app/out/x');
    expect(sourcePath('/logs/artifacts/', null)).toBe('/logs/artifacts');
  });
});

describe('tar --exclude', () => {
  test('unanchored, wildcards cross /, an excluded folder drops its contents', () => {
    expect(tarExcluded('a/b/c.tmp', ['*.tmp'])).toBe(true);
    expect(tarExcluded('node_modules/x/index.js', ['node_modules'])).toBe(true);
    expect(tarExcluded('src/node_modules/x.js', ['node_modules'])).toBe(true);
    expect(tarExcluded('src/cache/x', ['src/cache'])).toBe(true);
    expect(tarExcluded('src/keep.txt', ['*.tmp', 'cache/'])).toBe(false);
    expect(tarExcluded('a.txt', ['[ab].txt'])).toBe(true);
    expect(tarExcluded('c.txt', ['[!ab].txt'])).toBe(true);
  });
});

describe('sanitizing (tarfile data filter)', () => {
  test('modes lose setuid, setgid, sticky and group/other write; the owner reads and writes', () => {
    expect(sanitizedFileMode(0o4755)).toBe(0o755);
    expect(sanitizedFileMode(0o2777)).toBe(0o755);
    expect(sanitizedFileMode(0o444)).toBe(0o644);
    expect(sanitizedFileMode(0o057)).toBe(0o644);
    expect(sanitizedFileMode(0o175)).toBe(0o755);
    expect(sanitizedFileMode(0o011)).toBe(0o600);
  });
  test('special files, absolute symlinks and symlinks out of the artifact are skipped', () => {
    const tree = sanitizeTree(
      [
        entry('f', 'bin/run', 0o4755),
        entry('d', 'bin'),
        entry('l', 'bin/ok', 0o777, 'run'),
        entry('l', 'up', 0o777, '../tests/solution.png'),
        entry('l', 'deep/up', 0o777, '../../x'),
        entry('l', 'abs', 0o777, '/tests/solution.png'),
        entry('p', 'fifo'),
        entry('f', 'scratch.tmp'),
      ],
      ['*.tmp'],
    );
    expect(tree.files).toEqual([{ path: 'bin/run', mode: 0o755, size: 1 }]);
    expect(tree.dirs).toEqual(['bin']);
    expect(tree.symlinks).toEqual([{ path: 'bin/ok', target: 'run' }]);
    expect(tree.skipped.map((s) => [s.path, s.reason])).toEqual([
      ['up', 'symlink outside the artifact'],
      ['deep/up', 'symlink outside the artifact'],
      ['abs', 'absolute symlink'],
      ['fifo', 'special file'],
    ]);
  });
});

describe('the trial folder', () => {
  test('files at their host destination, and a manifest of every entry', () => {
    const bytes = new TextEncoder().encode('{}') as Uint8Array<ArrayBuffer>;
    const collected: CollectedArtifact[] = [
      { artifact: { source: '/logs/artifacts', destination: null, exclude: [] }, path: '/logs/artifacts', type: 'directory', status: 'empty', files: [], dirs: [], symlinks: [], skipped: [], error: null },
      { artifact: { source: '/app/report.json', destination: null, exclude: [] }, path: '/app/report.json', type: 'file', status: 'ok', files: [{ path: '', mode: 0o644, bytes }], dirs: [], symlinks: [], skipped: [], error: null },
      { artifact: { source: '/app/out', destination: 'out', exclude: [] }, path: '/app/out', type: 'directory', status: 'ok', files: [{ path: 'a/b.txt', mode: 0o644, bytes }], dirs: ['a'], symlinks: [], skipped: [], error: null },
      { artifact: { source: '/missing', destination: null, exclude: [] }, path: '/missing', type: 'directory', status: 'failed', files: [], dirs: [], symlinks: [], skipped: [], error: 'not found' },
    ];
    const files = artifactFiles(collected);
    expect(files.map((f) => f.path)).toEqual(['artifacts/app/report.json', 'artifacts/out/a/b.txt', 'artifacts/manifest.json']);
    const manifest = JSON.parse(files.at(-1)!.content as string);
    expect(manifest.map((m: { destination: string; status: string }) => [m.destination, m.status])).toEqual([
      ['logs/artifacts', 'empty'],
      ['app/report.json', 'ok'],
      ['out', 'ok'],
      ['missing', 'failed'],
    ]);
  });
});
