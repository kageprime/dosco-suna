/**
 * The per-agent file list does bounded work on repository content
 * (`agentReleaseFiles`, `ListBudget`). Each case is a repository built to
 * break one bound that a Strix review found missing (#13024, #13028): it must
 * end in a release or "too large", fast, and never stall the event loop.
 *
 * The fixture commits through one `git fast-import` per commit, into a bare
 * repository: thousands of files, and paths longer than a filesystem allows,
 * cost one process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitBackedProject } from '../projects/git/types';
import { __clearConfigReleaseCachesForTests, buildConfigRelease } from './builder';
import { refreshMirror } from '../projects/git/mirror';
import { __clearReleaseTreeMemosForTests, agentReleaseFiles, commitRootTree, ConfigArchiveTooLargeError, ListBudget, listConfigFiles } from './release-tree';
import { MemoryConfigArchiveStore } from './__tests__/fakes';

let root = '';
let work = '';
let project: GitBackedProject;
let store: MemoryConfigArchiveStore;
let tip: string | null = null;
const previousCache = process.env.KORTIX_GIT_CACHE_DIR;

function run(cmd: string, args: string[], cwd: string, input?: string | Buffer): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit `files` on top of the previous commit with one `git fast-import`, and push it. Each distinct body is written once. */
function commit(files: Record<string, string>, message: string): string {
  const chunks: Buffer[] = [];
  const data = (body: string | Buffer) => {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    chunks.push(Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from('\n'));
  };
  const marks = new Map<string, number>();
  for (const body of Object.values(files)) {
    if (marks.has(body)) continue;
    marks.set(body, marks.size + 1);
    chunks.push(Buffer.from(`blob\nmark :${marks.size}\n`));
    data(body);
  }
  chunks.push(Buffer.from('commit refs/heads/main\ncommitter T <t@kortix.invalid> 0 +0000\n'));
  data(message);
  if (tip) chunks.push(Buffer.from(`from ${tip}\n`));
  for (const [path, body] of Object.entries(files)) chunks.push(Buffer.from(`M 100644 :${marks.get(body)} ${path}\n`));
  run('git', ['fast-import', '--quiet'], work, Buffer.concat(chunks));
  tip = run('git', ['rev-parse', 'refs/heads/main'], work);
  run('git', ['push', '-q', '--force', 'origin', 'main'], work);
  return tip;
}

/** Run `fn` and return the longest time, in ms, the event loop could not run a 5 ms timer. */
async function longestStall<T>(fn: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
  let last = performance.now();
  let stallMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - last);
    last = now;
  }, 5);
  try {
    const result = await fn();
    stallMs = Math.max(stallMs, performance.now() - last);
    return { result, stallMs };
  } finally {
    clearInterval(timer);
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kortix-agent-release-bounds-'));
  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'git-cache');
});

afterAll(() => {
  if (previousCache === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousCache;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  __clearConfigReleaseCachesForTests();
  __clearReleaseTreeMemosForTests();
  const id = crypto.randomUUID();
  work = join(root, `work-${id}.git`);
  const remote = join(root, `remote-${id}.git`);
  run('git', ['init', '-q', '--bare', '--initial-branch=main', remote], root);
  run('git', ['init', '-q', '--bare', '--initial-branch=main', work], root);
  run('git', ['remote', 'add', 'origin', remote], work);
  tip = null;
  project = { projectId: id, repoUrl: remote, defaultBranch: 'main', manifestPath: 'kortix.yaml', gitAuthToken: 'local-test' };
  store = new MemoryConfigArchiveStore();
});


describe('agentReleaseFiles bounds', () => {
  // Strix review of #13024: repository content drives the file-list scan, so
  // its work must stay bounded on the API's event loop.
  test('a skill text built to make a link regex backtrack is scanned in linear time', async () => {
    const hostile = `${'](a'.repeat(40_000)}\n${'"./'.repeat(20_000)}\n${'](<'.repeat(20_000)}`;
    expect(hostile.length).toBeGreaterThan(200 * 1024);
    const sha = commit(
      {
        'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'skills:', '  notes: skills/notes', 'agents:', '  kortix:', '    prompt: Main.', '    skills: all', ''].join('\n'),
        'skills/notes/SKILL.md': `---\nname: notes\ndescription: Notes.\n---\nSee [style](../../shared/style.md).\n${hostile}\n`,
        'shared/style.md': 'Style.\n',
      },
      'hostile skill text',
    );
    const started = performance.now();
    const release = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(release.files?.map(([path]) => path)).toEqual(['shared/style.md', 'skills/notes/SKILL.md']);
  });

  test('the folders scope follows an import chain across folders, and a chain past the hop bound is too large', async () => {
    const chain = (length: number) => {
      const files: Record<string, string> = {
        'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  start: d0/tool.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
        'd0/tool.ts': 'export default { description: "t", parameters: { type: "object" }, execute: () => 1 }\n',
      };
      // Each folder holds a file nothing imports, which imports the next folder: only the folder rule reaches it.
      for (let at = 0; at < length; at += 1) {
        files[`d${at}/side.ts`] = `import { x } from '../d${at + 1}/x'\nexport const y = x\n`;
        files[`d${at + 1}/x.ts`] = 'export const x = 1\n';
      }
      return files;
    };
    const release = await buildConfigRelease(project, commit(chain(10), 'import chain'), 'repo-agent:kortix', { store });
    expect(release.reason).toBeNull();
    const paths = new Set(release.files!.map(([path]) => path));
    expect(paths.has('d10/x.ts')).toBe(true);
    expect(paths.has('d9/side.ts')).toBe(true);

    // Every hop is a folder round; a budget of 5 rounds ends a 10-folder chain.
    const sha = commit(chain(10), 'same chain');
    const mirror = await refreshMirror(project, true);
    const rootTree = await commitRootTree(mirror, sha);
    const budget = new ListBudget();
    budget.folderRounds = 5;
    const input = { toolModules: ['d0/tool.ts'], skillFolders: [], packageSources: [], rootFiles: [], scope: 'folders' as const };
    await expect(agentReleaseFiles(mirror, rootTree!, input, budget)).rejects.toBeInstanceOf(ConfigArchiveTooLargeError);
  }, 60_000);

  // Strix review of #13028: work must not scale with repeated links, paths or import depth.
  test('repeated folder links in many skill files walk the folder once', async () => {
    const links = '[apps](../../apps)\n'.repeat(2_000);
    const files: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'skills:', '  notes: skills/notes', 'agents:', '  kortix:', '    prompt: Main.', '    skills: all', ''].join('\n'),
      'skills/notes/SKILL.md': `---\nname: notes\ndescription: Notes.\n---\n${links}`,
    };
    for (let at = 0; at < 200; at += 1) files[`skills/notes/copies/c${at}.md`] = links;
    for (let at = 0; at < 3_000; at += 1) files[`apps/file-${at}.txt`] = `${at}\n`;
    const sha = commit(files, 'repeated links');
    const started = performance.now();
    const release = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(release.reason).toBeNull();
    expect(release.files!.filter(([path]) => path.startsWith('apps/')).length).toBe(3_000);
  }, 60_000);

  test('an import chain inside one folder past the git round-trip bound is too large; a short one is followed', async () => {
    const chain = (length: number) => {
      const files: Record<string, string> = {
        'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  start: tools/m0.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      };
      for (let at = 0; at < length; at += 1) files[`tools/m${at}.ts`] = `import './m${at + 1}'\nexport const v${at} = ${at}\n`;
      files[`tools/m${length}.ts`] = 'export const end = 1\n';
      return files;
    };
    const short = await buildConfigRelease(project, commit(chain(20), 'short chain'), 'agent:kortix', { store });
    expect(short.reason).toBeNull();
    expect(short.files!.length).toBe(21);

    // Each import depth costs git round trips; a budget of 30 ends a 40-module chain.
    const sha = commit(chain(40), 'long chain');
    const mirror = await refreshMirror(project, true);
    const rootTree = await commitRootTree(mirror, sha);
    const budget = new ListBudget();
    budget.gitCalls = 30;
    const input = { toolModules: ['tools/m0.ts'], skillFolders: [], packageSources: [], rootFiles: [], scope: 'exact' as const };
    await expect(agentReleaseFiles(mirror, rootTree!, input, budget)).rejects.toBeInstanceOf(ConfigArchiveTooLargeError);
  }, 60_000);

  test('a module imported from 3,000 paths with one blob is parsed once per loader', async () => {
    const files: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  fan: tools/fan.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      'tools/fan.ts': Array.from({ length: 3_000 }, (_, at) => `import './copies/m${at}'`).join('\n') + '\nexport default {}\n',
      'tools/copies/shared.ts': 'export const shared = 1\n',
    };
    for (let at = 0; at < 3_000; at += 1) files[`tools/copies/m${at}.ts`] = "import './shared'\nexport const same = 1\n";
    const sha = commit(files, 'fan out');
    const started = performance.now();
    const release = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(release.reason).toBeNull();
    expect(release.files!.length).toBe(3_002);
  }, 60_000);

  // Strix review 2 of #13028: a charged unit must not hide work a repository string controls,
  // and no build may stall the event loop.
  test('a multi-MiB import specifier at hundreds of paths never stalls the event loop', async () => {
    const hostile = `import '../${'a'.repeat(2 * 1024 * 1024)}'\nexport const x = 1\n`;
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  fan: tools/fan.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      'tools/fan.ts': Array.from({ length: 300 }, (_, at) => `import './h/m${at}'`).join('\n') + '\nexport default {}\n',
    };
    for (let at = 0; at < 300; at += 1) entries[`tools/h/m${at}.ts`] = hostile;
    const sha = commit(entries, 'long specifiers');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(500);
    // 300 copies of a 2 MiB module are over the tar bound: too large, never a stall.
    expect(result.release_id).toBeNull();
    expect(result.reason).toContain('exceed');
  }, 60_000);

  test('deep and long tool paths never stall the event loop', async () => {
    const deep = Array.from({ length: 400 }, () => 'd').join('/');
    const long = 'x'.repeat(3_000);
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', `  deep: ${deep}/t0.ts`, `  long: ${long}/t.ts`, 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
    };
    for (let at = 0; at < 500; at += 1) entries[`${deep}/t${at}.ts`] = `export const v = ${at}\n`;
    for (let at = 0; at < 2_000; at += 1) entries[`${long}/f${at}.txt`] = `${at}\n`;
    entries[`${long}/t.ts`] = 'export default {}\n';
    const sha = commit(entries, 'deep and long paths');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'repo-agent:kortix', { store }));
    expect(stallMs).toBeLessThan(500);
    // Either it lists every file beside the tools, or it is too large: never a stall.
    if (result.release_id) expect(result.files!.length).toBeGreaterThan(2_500);
    else expect(result.reason).toContain('exceed');
  }, 60_000);

  // Strix review 3 of #13028.
  test('skill text files under many long skill folders never stall the event loop', async () => {
    const entries: Record<string, string> = {};
    const skills: string[] = [];
    for (let at = 0; at < 300; at += 1) {
      // A skill folder is named after its skill; the long part is its parent.
      const folder = `skills/${'s'.repeat(200)}/k${at}`;
      skills.push(`  k${at}: ${folder}`);
      entries[`${folder}/SKILL.md`] = `---\nname: k${at}\ndescription: Skill.\n---\nSkill.\n`;
      for (let file = 0; file < 9; file += 1) entries[`${folder}/ref${file}.md`] = `Reference ${file}.\n`;
    }
    entries['kortix.yaml'] = ['project:', '  name: builder-test', 'default_agent: kortix', 'skills:', ...skills, 'agents:', '  kortix:', '    prompt: Main.', '    skills: all', ''].join('\n');
    const sha = commit(entries, 'many long skill folders');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(500);
    expect(result.reason).toBeNull();
    expect(result.files!.length).toBe(3_000);
  }, 120_000);

  test('parsing many large modules gives the event loop back between modules', async () => {
    const big = (at: number) => {
      const lines = [`import './m${at + 1}'`];
      for (let line = 0; line < 6_000; line += 1) lines.push(`export const v${line} = { k: 'value', n: ${line}, f: () => ${line} + 1 }`);
      return `${lines.join('\n')}\n`;
    };
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  big: tools/m0.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
    };
    for (let at = 0; at < 40; at += 1) entries[`tools/m${at}.ts`] = big(at);
    entries['tools/m40.ts'] = 'export const end = 1\n';
    expect(entries['tools/m0.ts']!.length).toBeGreaterThan(300 * 1024);
    expect(entries['tools/m0.ts']!.length).toBeLessThan(512 * 1024);
    const sha = commit(entries, 'large modules');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(150);
    expect(result.reason).toBeNull();
    expect(result.files!.length).toBe(41);
  }, 120_000);

  // Strix review 4 of #13028: listing and export-ignore over a whole large tree.
  test('a 100,000-file commit with an export-ignore rule never stalls the event loop', async () => {
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  t: tools/t.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      '.gitattributes': 'bulk/ignored/** export-ignore\n',
      'tools/t.ts': 'export default {}\n',
    };
    for (let at = 0; at < 100_000; at += 1) entries[`bulk/${at % 2 ? 'ignored' : 'kept'}/d${at % 97}/f${at}.txt`] = 'x\n';
    const sha = commit(entries, 'a large tree');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(300);
    expect(result.reason).toBeNull();
    expect(result.files!.map(([path]) => path)).toEqual(['tools/t.ts']);
  }, 120_000);

  // Strix review 10 of #13028: an agent's file list can be most of the tree (here a local pi
  // package of 100,000 files), and the list must not be copied into the tree thread on the
  // event loop: the thread makes it, and it crosses back once.
  test('an agent whose file list is a 100,000-file package never stalls the event loop', async () => {
    const entries: Record<string, string> = {
      'kortix.yaml': [
        'project:',
        '  name: builder-test',
        'default_agent: kortix',
        'extensions:',
        '  big:',
        '    pi: bulk',
        'agents:',
        '  kortix:',
        '    prompt: Main.',
        '    extensions: [big]',
        '',
      ].join('\n'),
      'bulk/index.ts': 'export default () => {}\n',
    };
    for (let at = 0; at < 100_000; at += 1) entries[`bulk/d${at % 97}/f${at}.txt`] = 'x\n';
    const sha = commit(entries, 'a large local package');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'repo-agent:kortix', { store }));
    expect(stallMs).toBeLessThan(100);
    expect(result.reason).toBeNull();
    expect(result.files!.length).toBe(100_002);
  }, 120_000);

  // Strix review 5 of #13028: every pass over repository data pays by its length and yields.
  test('unique deep paths under an export-ignore rule never stall the event loop', async () => {
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  t: tools/t.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      '.gitattributes': 'ignored/** export-ignore\n',
      'tools/t.ts': 'export default {}\n',
    };
    for (let at = 0; at < 2_000; at += 1) entries[`u${at}/${Array.from({ length: 500 }, () => 'abc').join('/')}/f.txt`] = 'x\n';
    const sha = commit(entries, 'unique deep paths');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(300);
    if (result.release_id) expect(result.files!.map(([path]) => path)).toEqual(['tools/t.ts']);
    else expect(result.reason).toContain('exceed');
  }, 120_000);

  test('a tool importing 20,000 tiny modules never stalls the event loop', async () => {
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  fan: tools/fan.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
      'tools/fan.ts': Array.from({ length: 20_000 }, (_, at) => `import './t/m${at}'`).join('\n') + '\n',
    };
    for (let at = 0; at < 20_000; at += 1) entries[`tools/t/m${at}.ts`] = `export const v${at} = ${at}\n`;
    const sha = commit(entries, 'tiny modules');
    const { result, stallMs } = await longestStall(() => buildConfigRelease(project, sha, 'agent:kortix', { store }));
    expect(stallMs).toBeLessThan(300);
    if (result.release_id) expect(result.files!.length).toBe(20_001);
    else expect(result.reason).toContain('exceed');
  }, 120_000);

  // Strix review 6 of #13028: git's byte order and JavaScript's UTF-16 order differ for some
  // non-ASCII paths, so the listing must be re-sorted, paced.
  test('a listing git and JavaScript order differently is sorted without a stall, and lookups still find every file', async () => {
    const entries: Record<string, string> = {
      'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'skills:', '  notes: skills/notes', 'agents:', '  kortix:', '    prompt: Main.', '    skills: all', ''].join('\n'),
      // Manifest paths are ASCII; the lookup still binary-searches the re-sorted non-ASCII listing.
      'skills/notes/SKILL.md': '---\nname: notes\ndescription: Notes.\n---\nNotes.\n',
    };
    // U+FFFD sorts before an emoji in UTF-8 bytes (git), after it in UTF-16 units (JavaScript).
    for (let at = 0; at < 20_000; at += 1) entries[`bulk/${at % 2 ? '\uFFFD' : '\u{1F600}'}${'n'.repeat(200)}${at}.txt`] = 'x\n';
    const sha = commit(entries, 'non-ASCII order');
    const mirror = await refreshMirror(project, true);
    const rootTree = await commitRootTree(mirror, sha);
    const { result: listed, stallMs } = await longestStall(() => listConfigFiles(mirror, rootTree!));
    expect(stallMs).toBeLessThan(300);
    for (let at = 1; at < listed.length; at += 1) expect(listed[at - 1]![0] < listed[at]![0]).toBe(true);
    const release = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(release.reason).toBeNull();
    expect(release.files!.map(([path]) => path)).toEqual(['skills/notes/SKILL.md']);
  }, 120_000);

  test('a tool module over the parse bound ships but is not parsed for imports', async () => {
    const big = `import { side } from './side'\nexport const blob = "${'a'.repeat(11 * 1024 * 1024)}"\nexport default { description: "b", parameters: { type: "object" }, execute: () => side }\n`;
    const sha = commit(
      {
        'kortix.yaml': ['project:', '  name: builder-test', 'default_agent: kortix', 'tools:', '  big: tools/big.ts', 'agents:', '  kortix:', '    prompt: Main.', ''].join('\n'),
        'tools/big.ts': big,
        'tools/side.ts': 'export const side = 1\n',
      },
      'big module',
    );
    const release = await buildConfigRelease(project, sha, 'agent:kortix', { store });
    expect(release.reason).toBeNull();
    expect(release.files?.map(([path]) => path)).toEqual(['tools/big.ts']);
  }, 60_000);
});
