import { describe, expect, test } from 'bun:test';
import { gzipSync } from 'node:zlib';
import { checkedTaskVersion, extractTaskArchive, isHubName, parseHubPackage, parseHubRef } from './hub';
import { decodeTaskId, encodeTaskId } from './task-id';

/** A ustar archive of `entries`: `type` 0 file, 2 symlink, 1 hardlink, 3 char device, 5 dir; `x` adds a pax `path`. */
function tarOf(entries: Array<{ path: string; type?: string; body?: string; link?: string; pax?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const header = (path: string, type: string, size: number, link = '') => {
    const block = new Uint8Array(512);
    const put = (text: string, at: number) => block.set(new TextEncoder().encode(text), at);
    put(path.slice(0, 99), 0);
    put('0000644\0', 100);
    put(`${size.toString(8).padStart(11, '0')}\0`, 124);
    put(type, 156);
    put(link.slice(0, 99), 157);
    put('ustar\x0000', 257);
    put('        ', 148);
    const sum = block.reduce((a, b) => a + b, 0);
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const body = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    return padded;
  };
  for (const entry of entries) {
    if (entry.pax) {
      // A pax record is `<length> path=<value>\n`, where the length counts its own digits.
      const record = ` path=${entry.pax}\n`;
      let length = record.length + 1;
      while (String(length).length + record.length !== length) length = String(length).length + record.length;
      const line = `${length}${record}`;
      blocks.push(header('PaxHeader', 'x', line.length), body(line));
    }
    const content = entry.body ?? '';
    blocks.push(header(entry.path, entry.type ?? '0', entry.type && entry.type !== '0' ? 0 : content.length, entry.link));
    if ((!entry.type || entry.type === '0') && content) blocks.push(body(content));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return gzipSync(out);
}

const text = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder().decode(bytes) : undefined);

describe('Harbor Hub refs', () => {
  test('a ref is a tag, a revision or a full digest, as Harbor reads it', () => {
    expect(parseHubRef(undefined)).toEqual({ type: 'tag', value: 'latest' });
    expect(parseHubRef('')).toEqual({ type: 'tag', value: 'latest' });
    expect(parseHubRef('stable')).toEqual({ type: 'tag', value: 'stable' });
    expect(parseHubRef('3')).toEqual({ type: 'revision', value: 3 });
    expect(parseHubRef(`sha256:${'a'.repeat(64)}`)).toEqual({ type: 'digest', value: `sha256:${'a'.repeat(64)}` });
    expect(() => parseHubRef('sha256:abc')).toThrow(/full sha256 digest/);
    expect(() => parseHubRef('Has Space')).toThrow(/tag/);
  });

  test('a package name is org/name, optionally @ref, and names its version once', () => {
    expect(parseHubPackage('hello-world/hello-world')).toEqual({ org: 'hello-world', name: 'hello-world', ref: { type: 'tag', value: 'latest' } });
    expect(parseHubPackage('terminal-bench/terminal-bench-2-1@2')).toEqual({ org: 'terminal-bench', name: 'terminal-bench-2-1', ref: { type: 'revision', value: 2 } });
    expect(parseHubPackage('org/name', 'stable').ref).toEqual({ type: 'tag', value: 'stable' });
    expect(() => parseHubPackage('org/name@1', '2')).toThrow(/version twice/);
    expect(() => parseHubPackage('terminal-bench')).toThrow(/org\/name/);
    expect(() => parseHubPackage('a/../b')).toThrow();
  });

  test('a name with a slash is a Hub package; a legacy registry name is not', () => {
    expect(isHubName('terminal-bench/terminal-bench-2-1')).toBe(true);
    expect(isHubName('hello-world/hello-world@latest')).toBe(true);
    expect(isHubName('terminal-bench')).toBe(false);
    expect(isHubName('terminal-bench@2.0')).toBe(false);
  });
});

describe('Hub task versions', () => {
  const hash = 'c'.repeat(64);
  const task = { org: 'acme', name: 'fix-it', content_hash: hash, archive_path: `packages/acme/fix-it/${hash}/dist.tar.gz` };

  test('an archive must sit in its own package folder under its content hash', () => {
    expect(checkedTaskVersion(task)).toEqual(task);
    expect(checkedTaskVersion({ ...task, archive_path: `packages/acme/fix-it/${hash}/archive.harbor` }).archive_path).toEndWith('archive.harbor');
    expect(() => checkedTaskVersion({ ...task, archive_path: `packages/other/pkg/${hash}/dist.tar.gz` })).toThrow();
    expect(() => checkedTaskVersion({ ...task, archive_path: `packages/acme/fix-it/${hash}/../../x` })).toThrow();
    expect(() => checkedTaskVersion({ ...task, content_hash: 'abc' })).toThrow();
  });

  test('a Hub task id decodes back to the same pinned version, and a forged one is no task', () => {
    const P = '11111111-1111-4111-8111-111111111111';
    const ref = { kind: 'package' as const, ...task, path: '' as const };
    const id = encodeTaskId(P, { ...ref, source: 'acme/set@3' }, 'a'.repeat(40));
    expect(decodeTaskId(P, id)).toEqual({ ref, commit: hash });
    const [, signature] = id.split('~');
    const forged = Buffer.from(JSON.stringify({ k: 'pkg', o: 'acme', n: 'fix-it', h: hash, a: `packages/acme/fix-it/${hash}/big.tar.gz`.replace('acme/fix-it', 'evil/pkg') })).toString('base64url');
    expect(decodeTaskId(P, `${forged}~${signature}`)).toBeNull();
  });
});

describe('extractTaskArchive', () => {
  test('reads files, pax long paths, and links that stay inside the task as copies', () => {
    const long = `tests/${'deep/'.repeat(30)}case.txt`;
    const out = extractTaskArchive(
      tarOf([
        { path: 'environment', type: '5' },
        { path: 'task.toml', body: 'version = "1.0"\n' },
        { path: './instruction.md', body: 'Say hi.\n' },
        { path: 'tests/test.sh', body: 'echo 1 > /logs/verifier/reward.txt\n' },
        { path: 'x', pax: long, body: 'deep' },
        { path: 'tests/again.sh', type: '2', link: 'test.sh' },
        { path: 'solution/copy.sh', type: '1', link: 'tests/test.sh' },
        { path: 'tests/up.sh', type: '2', link: '../task.toml' },
      ]),
    );
    expect([...out.files.keys()].sort()).toEqual(['instruction.md', long, 'solution/copy.sh', 'task.toml', 'tests/again.sh', 'tests/test.sh', 'tests/up.sh'].sort());
    expect(text(out.files.get('tests/again.sh'))).toBe('echo 1 > /logs/verifier/reward.txt\n');
    expect(text(out.files.get('solution/copy.sh'))).toBe('echo 1 > /logs/verifier/reward.txt\n');
    expect(text(out.files.get('tests/up.sh'))).toBe('version = "1.0"\n');
    expect(out.skipped).toEqual([]);
  });

  test('leaves out links that point outside the task, absolute links and devices', () => {
    const out = extractTaskArchive(
      tarOf([
        { path: 'task.toml', body: 'x' },
        { path: 'tests/secret', type: '2', link: '../../etc/passwd' },
        { path: 'tests/abs', type: '2', link: '/etc/passwd' },
        { path: 'tests/hard', type: '1', link: 'missing' },
        { path: 'tests/dev', type: '3' },
      ]),
    );
    expect([...out.files.keys()]).toEqual(['task.toml']);
    expect(out.skipped.sort()).toEqual(['tests/abs', 'tests/dev', 'tests/hard', 'tests/secret']);
  });

  test('refuses an absolute path, a .. segment and an archive over the limit', () => {
    expect(() => extractTaskArchive(tarOf([{ path: '/etc/cron.d/x', body: 'x' }]))).toThrow(/unsafe path/);
    expect(() => extractTaskArchive(tarOf([{ path: 'tests/../../x', body: 'x' }]))).toThrow(/unsafe path/);
    expect(() => extractTaskArchive(tarOf([{ path: 'big', body: 'x'.repeat(4096) }]), 1024)).toThrow(/larger than/);
    expect(() => extractTaskArchive(new Uint8Array([1, 2, 3]))).toThrow(/not a gzip/);
  });
});
