import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Characterization of the sessions family's help decision (KRTX-4804): for
 * every subcommand whose runner hand-rolled the `-h` / `--help` check, pin the
 * exact `--help` stdout (sha256), its exit code and its trailing newlines,
 * plus every subcommand's bare-invocation exit code, so the checks stay on
 * `splitHelp` verifiably. The real CLI process, hermetic (no config, no
 * network, stdin ignored).
 *
 * `help` (formatHelp) renders every help text with a leading newline and one
 * trailing blank line, so every `--help` output ends with exactly two
 * newlines. A bare invocation of a command that only needs a target prints
 * that help too (exit 2, the splitHelp grammar); a bare invocation that does
 * the command's real work (chat/log/status/digest/shell) writes nothing to
 * stdout — the pins hold both shapes.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

const dir = mkdtempSync(join(tmpdir(), 'sessions-help-characterization-'));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const trailingNewlines = (s: string) => /(\n+)$/.exec(s)?.[1].length ?? 0;

/**
 * subcommand → [bare exit code, sha256 of the exact `--help` stdout, its
 * trailing newlines (2 = formatHelp's one blank line), what a bare invocation
 * writes to stdout where that must not change: 'help' = the help text, 'empty'
 * = nothing].
 */
type Pin = [number, string, number, ('help' | 'empty')?];

const PINS: Record<string, Pin> = {
  chat: [1, '53ac2cd37bf635481e1db17ddd449b5f5d798700d8c70939731c099a8c6102d9', 2, 'empty'],
  log: [1, '1c2aa839ede4a9bb2df73c8a8574f6fd150d27e4008de41e9534f4783669f1c1', 2, 'empty'],
  status: [1, '5f209fc572d0a7acb8d95907588435959c13c2cdf13b74503b603524afdb59a3', 2, 'empty'],
  digest: [1, '1b98706b9b37fff00642271c6dab8ed12e0c236d4cf58cf3c05a80835803e029', 2, 'empty'],
  forward: [2, '5ca8093c8f0ca9b2d4b2711dfa1f5fbd0276b758afc7055997ee3054beeb86ab', 2],
  shell: [1, '904c52a3be97326ca52637377989f60b13303d6f24f599525472dd330f0cbd68', 2, 'empty'],
  attachments: [2, '3c1d2c8a0082644072173e55728e5e5b220bc5076fcbb55b54e89b51ecc8a6b9', 2],
  pending: [2, '2c11c80895de49241302f71478c81d0bce6df40bcab02ff0cc07c8220f9645b3', 2],
  usage: [2, '79a5f8d9822aba5f01b14191be5dc0cadb4dba0d2a4068e77cff0967cfbf7a40', 2],
  approve: [2, 'dc12cdc172d1c4613cc155486dec12b0ea68ecb00c96c03991c7edccb943d7e4', 2],
  answer: [2, 'f56c86211bced1c3d7531eb3b82b0889251de89b3c98c0ee95658605f92634e1', 2],
  approvals: [2, '65b3a5675a051f2a856d00c24e56d5214a0905bb653ed7ac3724678c77de3fd8', 2],
  cp: [2, 'd7a53a21e6591c386a5af4c868dc69cff0ec084f2e76fd5f6b641fff1b5a0ec9', 2, 'help'],
  stop: [2, 'd7f06d7a478438a30a1f30136969082e740a0cf197ba650a9435a24436248738', 2],
  start: [2, 'fc37a9895a4033ce54aac8cfe7279c937dbe1e7e746d51de062dad5ee32af342', 2],
  restore: [2, '4ef80b50c8cd6ab9e2ca1523a8dc863c7af7dfcab6bc0b9770e1fd7fb23369ee', 2],
  recover: [2, '830ab1b89ca9a3907a29e2329b3b04f5dc6c61c97a9f39aa2d41157fdda35080', 2],
  model: [2, '771511ba280e0a606b36a83cd0cba29dba939cb134470f81bada615b27539884', 2],
  compact: [2, 'a5d0b1abfd4003235499140032d54cdbf0c181a08718b80fdc1ffd498d6fd4cb', 2],
  queue: [2, '165125be3cb823515f69e2a44143ac1d80d646d39832382d974066a2247729af', 2],
  files: [2, '49f8fa5645ff956545afdcbec8a577c8de1b127a1abcff4fcab39a9e0308aaf7', 2],
  share: [2, '2f62b3b7ab54ef4ac12f1523577964169e55f67c844ef947b77ab860191e5386', 2],
  links: [2, '6880e58aa8160b7d36c4c24e064fa1ed277c34638cd966f94b7742681e1caf31', 2],
  'wait-for': [2, '1f8f17ba3961f6deecace824b589c9943f6748ac62fbd64f953c3714ddda8d18', 2, 'help'],
  reachable: [1, 'e18c0ac24df5984872e82d0fa8428dbcb4ecfe65bcc138dd3617ef355be12c51', 2, 'empty'],
  inbound: [2, '18626b1901a2a725ccdba26ff671461748780dc30b57aa3ae4328ba2c755beef', 2, 'help'],
  scope: [2, '0a867b789ae8e1d62923e5e2b91eb25cf9b1ae9a2431c0a977035c24d784335a', 2],
  message: [2, '6a8f5e03833b1bf39d3a0ff6431c5e716ac738d9ca7b3cd5321653aee680c357', 2],
};

/** The group help's sha: bare `sessions`, `<sub> --help` behind the group
 *  guard and the group's own `--help` all print the same bytes. */
const GROUP_HELP_SHA = 'f6bd00009634e41f8502422730bdc6158ae372d94ea3cbda6f4510c0bb9aae5b';

async function runCli(args: string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    // A path that does not exist: the CLI is NOT logged in for this run, so
    // every case here exits before any network call.
    KORTIX_CONFIG_FILE: join(dir, 'missing-config.json'),
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_TOKEN',
    'KORTIX_PROJECT_ID',
    'KORTIX_SESSION_ID',
    'KORTIX_FEATURE_FLAGS',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: dir,
    env: env as Record<string, string>,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(9), 15_000);
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

describe('sessions subcommand --help and bare invocation (KRTX-4804)', () => {
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [sub, [bare, helpSha, helpTrailing, bareBytes]] of Object.entries(PINS)) {
    test(`${sub} --help prints its help text, exit 0`, async () => {
      const result = await runCli(['sessions', sub, '--help']);
      expect(result.code).toBe(0);
      expect(sha(result.stdout)).toBe(helpSha);
      expect(trailingNewlines(result.stdout)).toBe(helpTrailing);
    });

    test(`${sub} bare exits ${bare}${bareBytes ? ' with its pinned stdout' : ''}`, async () => {
      const result = await runCli(['sessions', sub]);
      expect(result.code).toBe(bare);
      if (bareBytes === 'help') expect(sha(result.stdout)).toBe(helpSha);
      if (bareBytes === 'empty') expect(result.stdout).toBe('');
    });
  }

  describe('the group guard', () => {
    test('bare `sessions` prints the group help, exit 2', async () => {
      const result = await runCli(['sessions']);
      expect(result.code).toBe(2);
      expect(sha(result.stdout)).toBe(GROUP_HELP_SHA);
      expect(trailingNewlines(result.stdout)).toBe(2);
    });

    for (const args of [['ls'], ['info'], ['xyz']]) {
      test(`sessions ${args[0]} --help prints the group help, exit 0`, async () => {
        const result = await runCli(['sessions', ...args, '--help']);
        expect(result.code).toBe(0);
        expect(sha(result.stdout)).toBe(GROUP_HELP_SHA);
        expect(trailingNewlines(result.stdout)).toBe(2);
      });
    }
  });
});
