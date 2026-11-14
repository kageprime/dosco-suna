/**
 * The read-only baseline `kortix plan` prints: the repository, its stack, its
 * env files key by key and the integrations it uses. Deterministic: the same
 * tree gives the same report. Env values are read in this process only to
 * classify a key; no value, and no part of one, enters the result.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { pointsAtRemote } from '../commands/env.ts';
import { githubRepoFromRemote } from '../github-remote.ts';
import { runGit } from '../git-run.ts';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.venv', 'venv', 'target', 'vendor',
  'coverage', '.cache', 'out', '.output', '.vercel', '.wrangler', '.svelte-kit', '__pycache__', '.pnpm-store',
]);
const MAX_DEPTH = 5;

function rel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/') || '.';
}

function readText(abs: string): string | null {
  try {
    const info = statSync(abs);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function readJson(abs: string): Record<string, unknown> | null {
  const text = readText(abs);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every file under `root` to MAX_DEPTH, repo-relative, sorted, without build and dependency folders. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < MAX_DEPTH) walk(abs, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel(root, abs));
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

// ── Repository ───────────────────────────────────────────────────────────────

export interface RepositoryReport {
  root: string;
  git: boolean;
  github: { owner: string; repo: string } | null;
  /** `github`, `other` (a remote that is not on github.com) or `none`. */
  origin: 'github' | 'other' | 'none';
  default_branch: string | null;
  current_branch: string | null;
  clean: boolean;
  changed_files: number;
  layout: { workspaces: string[]; apps: string[]; packages: string[] };
}

function expandWorkspaceGlobs(root: string, patterns: string[]): string[] {
  const dirs = new Set<string>();
  for (const raw of patterns) {
    if (raw.startsWith('!')) continue;
    const pattern = raw.replace(/\/+$/, '').replace(/^\.\//, '');
    const star = pattern.indexOf('*');
    if (star === -1) {
      if (existsSync(join(root, pattern, 'package.json'))) dirs.add(pattern);
      continue;
    }
    const parent = pattern.slice(0, star).replace(/\/$/, '');
    const recursive = pattern.includes('**');
    const walk = (dir: string, depth: number) => {
      let entries;
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
        const child = dir ? `${dir}/${entry.name}` : entry.name;
        if (existsSync(join(root, child, 'package.json'))) dirs.add(child);
        if (recursive && depth < 3) walk(child, depth + 1);
      }
    };
    walk(parent, 0);
  }
  return [...dirs].sort();
}

function workspaceDirs(root: string, files: Set<string>): { tools: string[]; dirs: string[] } {
  const tools: string[] = [];
  const patterns: string[] = [];
  if (files.has('pnpm-workspace.yaml')) {
    try {
      // A pnpm-workspace.yaml with no `packages` only holds settings: not a monorepo.
      const doc = parseYaml(readText(join(root, 'pnpm-workspace.yaml')) ?? '') as { packages?: unknown };
      if (Array.isArray(doc?.packages) && doc.packages.length > 0) {
        tools.push('pnpm');
        patterns.push(...doc.packages.filter((p): p is string => typeof p === 'string'));
      }
    } catch {
      /* an unparsable workspace file lists no packages */
    }
  }
  const pkg = readJson(join(root, 'package.json'));
  const ws = pkg?.workspaces;
  const wsList = Array.isArray(ws) ? ws : ws && typeof ws === 'object' ? (ws as { packages?: unknown }).packages : null;
  if (Array.isArray(wsList)) {
    tools.push(files.has('yarn.lock') ? 'yarn' : files.has('bun.lock') || files.has('bun.lockb') ? 'bun' : 'npm');
    patterns.push(...wsList.filter((p): p is string => typeof p === 'string'));
  }
  if (files.has('turbo.json')) tools.push('turbo');
  if (files.has('nx.json')) tools.push('nx');
  if (files.has('lerna.json')) tools.push('lerna');
  return { tools, dirs: expandWorkspaceGlobs(root, patterns) };
}

export function scanRepository(root: string, files: Set<string>): RepositoryReport {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  const git = inside.ok && inside.stdout.trim() === 'true';
  const remote = git ? runGit(root, ['remote', 'get-url', 'origin']) : null;
  const github = remote?.ok ? githubRepoFromRemote(remote.stdout) : null;
  const head = git ? runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) : null;
  const current = git ? runGit(root, ['branch', '--show-current']).stdout.trim() || null : null;
  const porcelain = git ? runGit(root, ['status', '--porcelain']).stdout.split('\n').filter(Boolean) : [];
  const { tools, dirs } = workspaceDirs(root, files);
  return {
    root,
    git,
    github: github ? { owner: github.split('/')[0]!, repo: github.split('/')[1]! } : null,
    origin: github ? 'github' : remote?.ok ? 'other' : 'none',
    default_branch: head?.ok && head.stdout.trim() ? head.stdout.trim().replace(/^origin\//, '') : current,
    current_branch: current,
    clean: porcelain.length === 0,
    changed_files: porcelain.length,
    layout: {
      workspaces: tools,
      apps: dirs.filter((dir) => /^(apps|services)\//.test(dir)),
      packages: dirs.filter((dir) => !/^(apps|services)\//.test(dir)),
    },
  };
}

// ── Stack ────────────────────────────────────────────────────────────────────

export interface StackReport {
  languages: Array<{ name: string; version: string | null; evidence: string }>;
  package_managers: Array<{ name: string; lockfile: string | null; version: string | null }>;
  services: Array<{ name: string; kind: string; evidence: string }>;
  commands: Array<{ name: string; command: string; package: string }>;
  /** `secrets`: the secret names the workflow reads (`secrets.NAME`), never a value. */
  ci: Array<{ workflow: string; on: string[]; runs: string[]; secrets: string[] }>;
  browser_tests: Array<{ tool: string; evidence: string }>;
}

const SCRIPT_NAME = /^(dev|start|serve|build|test|test:[\w:-]+|e2e|e2e:[\w:-]+|lint|typecheck|type-check|check|format|db:[\w:-]+|migrate)$/;

function firstMatch(text: string | null, re: RegExp): string | null {
  const match = text?.match(re);
  return match ? match[1]!.trim() : null;
}

function packageJsons(root: string, repo: RepositoryReport): Array<{ dir: string; pkg: Record<string, unknown> }> {
  const dirs = ['.', ...repo.layout.apps, ...repo.layout.packages];
  return dirs
    .map((dir) => ({ dir, pkg: readJson(join(root, dir, 'package.json')) }))
    .filter((row): row is { dir: string; pkg: Record<string, unknown> } => row.pkg !== null);
}

function depsOf(pkg: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[key];
    if (block && typeof block === 'object') names.push(...Object.keys(block as Record<string, unknown>));
  }
  return names;
}

function composeServices(root: string, files: string[]): StackReport['services'] {
  const out: StackReport['services'] = [];
  for (const file of files.filter((f) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(f))) {
    const text = readText(join(root, file)) ?? '';
    const secrets = [...new Set([...text.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!))].filter((name) => name !== 'GITHUB_TOKEN').sort();
    try {
      const doc = parseYaml(text) as { services?: Record<string, { image?: unknown }> };
      for (const [name, svc] of Object.entries(doc?.services ?? {})) {
        const image = typeof svc?.image === 'string' ? svc.image.split(':')[0]! : 'build';
        out.push({ name, kind: `docker-compose (${image})`, evidence: file });
      }
    } catch {
      out.push({ name: basename(file), kind: 'docker-compose (unparsable)', evidence: file });
    }
  }
  return out;
}

function ciWorkflows(root: string, files: string[]): StackReport['ci'] {
  const out: StackReport['ci'] = [];
  for (const file of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    const text = readText(join(root, file)) ?? '';
    const secrets = [...new Set([...text.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g)].map((m) => m[1]!))].filter((name) => name !== 'GITHUB_TOKEN').sort();
    try {
      const doc = parseYaml(text) as { on?: unknown; true?: unknown; jobs?: Record<string, { steps?: Array<{ run?: unknown }> }> };
      const on = doc?.on ?? doc?.true;
      const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];
      const runs: string[] = [];
      for (const job of Object.values(doc?.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          if (typeof step?.run !== 'string') continue;
          for (const line of step.run.split('\n').map((l) => l.trim()).filter(Boolean)) {
            const short = line.length > 160 ? `${line.slice(0, 157)}...` : line;
            if (!runs.includes(short) && runs.length < 12) runs.push(short);
          }
        }
      }
      out.push({ workflow: file, on: events, runs, secrets });
    } catch {
      out.push({ workflow: file, on: [], runs: [], secrets });
    }
  }
  return out;
}

export function scanStack(root: string, fileList: string[], repo: RepositoryReport): StackReport {
  const files = new Set(fileList);
  const pkgs = packageJsons(root, repo);
  const rootPkg = pkgs.find((row) => row.dir === '.')?.pkg ?? null;
  const toolVersions = readText(join(root, '.tool-versions'));
  const languages: StackReport['languages'] = [];
  const lang = (name: string, version: string | null, evidence: string) => {
    if (!languages.some((l) => l.name === name)) languages.push({ name, version, evidence });
  };
  const engines = rootPkg?.engines as Record<string, unknown> | undefined;
  if (files.has('.nvmrc')) lang('node', readText(join(root, '.nvmrc'))?.trim() || null, '.nvmrc');
  else if (files.has('.node-version')) lang('node', readText(join(root, '.node-version'))?.trim() || null, '.node-version');
  else if (firstMatch(toolVersions, /^nodejs\s+(\S+)/m)) lang('node', firstMatch(toolVersions, /^nodejs\s+(\S+)/m), '.tool-versions');
  else if (typeof engines?.node === 'string') lang('node', engines.node, 'package.json engines');
  else if (rootPkg) lang('node', null, 'package.json');
  if (files.has('bun.lock') || files.has('bun.lockb') || typeof engines?.bun === 'string') lang('bun', typeof engines?.bun === 'string' ? engines.bun : firstMatch(toolVersions, /^bun\s+(\S+)/m), files.has('bun.lock') ? 'bun.lock' : 'package.json');
  if (files.has('pyproject.toml') || files.has('requirements.txt') || files.has('.python-version')) {
    const version = readText(join(root, '.python-version'))?.trim() || firstMatch(readText(join(root, 'pyproject.toml')), /requires-python\s*=\s*["']([^"']+)["']/) || firstMatch(toolVersions, /^python\s+(\S+)/m);
    lang('python', version || null, files.has('pyproject.toml') ? 'pyproject.toml' : files.has('.python-version') ? '.python-version' : 'requirements.txt');
  }
  if (files.has('go.mod')) lang('go', firstMatch(readText(join(root, 'go.mod')), /^go\s+(\S+)/m), 'go.mod');
  if (files.has('Cargo.toml')) lang('rust', firstMatch(readText(join(root, 'rust-toolchain.toml')), /channel\s*=\s*"([^"]+)"/) ?? readText(join(root, 'rust-toolchain'))?.trim() ?? null, 'Cargo.toml');
  if (files.has('Gemfile')) lang('ruby', readText(join(root, '.ruby-version'))?.trim() || null, 'Gemfile');
  if (files.has('pom.xml') || files.has('build.gradle') || files.has('build.gradle.kts')) lang('java', firstMatch(toolVersions, /^java\s+(\S+)/m), files.has('pom.xml') ? 'pom.xml' : 'build.gradle');
  if (files.has('deno.json') || files.has('deno.jsonc')) lang('deno', null, files.has('deno.json') ? 'deno.json' : 'deno.jsonc');

  const managers: StackReport['package_managers'] = [];
  const declared = typeof rootPkg?.packageManager === 'string' ? rootPkg.packageManager : null;
  const lockfiles: Array<[string, string]> = [
    ['pnpm', 'pnpm-lock.yaml'], ['npm', 'package-lock.json'], ['yarn', 'yarn.lock'], ['bun', 'bun.lock'], ['bun', 'bun.lockb'],
    ['uv', 'uv.lock'], ['poetry', 'poetry.lock'], ['pipenv', 'Pipfile.lock'], ['pip', 'requirements.txt'],
    ['go', 'go.sum'], ['cargo', 'Cargo.lock'], ['bundler', 'Gemfile.lock'],
  ];
  for (const [name, lockfile] of lockfiles) {
    if (!files.has(lockfile) || managers.some((m) => m.name === name)) continue;
    const version = declared?.startsWith(`${name}@`) ? declared.slice(name.length + 1).split('+')[0]! : null;
    managers.push({ name, lockfile, version });
  }
  if (declared && !managers.some((m) => declared.startsWith(`${m.name}@`))) {
    const [name, version] = declared.split('@');
    managers.push({ name: name!, lockfile: null, version: version?.split('+')[0] ?? null });
  }

  const allDeps = new Set(pkgs.flatMap((row) => depsOf(row.pkg)));
  const services = composeServices(root, fileList);
  if (files.has('convex.json') || fileList.some((f) => /^convex\/[^/]+\.(ts|js)$/.test(f)) || allDeps.has('convex')) services.push({ name: 'convex', kind: 'convex', evidence: files.has('convex.json') ? 'convex.json' : files.has('convex/schema.ts') ? 'convex/schema.ts' : fileList.find((f) => /^convex\/[^/]+$/.test(f)) ?? 'package.json' });
  if (files.has('supabase/config.toml')) services.push({ name: 'supabase', kind: 'supabase (local stack)', evidence: 'supabase/config.toml' });
  const prisma = fileList.find((f) => f.endsWith('schema.prisma'));
  if (prisma) services.push({ name: 'prisma', kind: `prisma (${firstMatch(readText(join(root, prisma)), /provider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver|cockroachdb)"/) ?? 'database'})`, evidence: prisma });
  const drizzle = fileList.find((f) => /(^|\/)drizzle\.config\.(ts|js|mjs)$/.test(f));
  if (drizzle) services.push({ name: 'drizzle', kind: 'drizzle (database)', evidence: drizzle });

  const commands: StackReport['commands'] = [];
  for (const { dir, pkg } of pkgs) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command === 'string' && SCRIPT_NAME.test(name)) commands.push({ name, command, package: dir });
    }
  }
  for (const target of ['dev', 'test', 'build', 'lint', 'e2e']) {
    const make = readText(join(root, 'Makefile'));
    if (make && new RegExp(`^${target}:`, 'm').test(make)) commands.push({ name: target, command: `make ${target}`, package: '.' });
  }

  const browser: StackReport['browser_tests'] = [];
  const pw = fileList.find((f) => /(^|\/)playwright\.config\.(ts|js|mjs|cjs)$/.test(f));
  if (pw || allDeps.has('@playwright/test')) browser.push({ tool: 'playwright', evidence: pw ?? 'package.json: @playwright/test' });
  const cy = fileList.find((f) => /(^|\/)cypress\.config\.(ts|js|mjs|cjs)$/.test(f));
  if (cy || allDeps.has('cypress')) browser.push({ tool: 'cypress', evidence: cy ?? 'package.json: cypress' });

  return { languages, package_managers: managers, services, commands, ci: ciWorkflows(root, fileList), browser_tests: browser };
}

// ── Env files ────────────────────────────────────────────────────────────────

export type EnvClass = 'local' | 'remote' | 'prod';

export interface EnvKey {
  name: string;
  class: EnvClass;
  empty: boolean;
  encrypted: boolean;
}

export interface EnvFile {
  file: string;
  /** `.env.example` and the like: names a developer must set, no real values. */
  example: boolean;
  /** dotenvx `.env.keys`: the private keys that decrypt the encrypted files. */
  dotenvx_keys: boolean;
  keys: EnvKey[];
}

export interface EnvReport {
  files: EnvFile[];
  /** Names an example file declares that no other env file in its folder sets. */
  example_only: Array<{ name: string; example: string }>;
  /** Value schemes seen (postgres, redis, …): which local services the env expects. No host, no value. */
  schemes: string[];
}

const ENV_FILE = /^\.env(\.[\w.-]+)?$|^\.dev\.vars$/;
const EXAMPLE_FILE = /\.(example|sample|template|dist|defaults)$/i;
const PROD_FILE = /(^|[.\-_])(prod|production|live)([.\-_]|$)/i;
const REMOTE_FILE = /(^|[.\-_])(staging|stage|preview|qa|uat|remote)([.\-_]|$)/i;
const PROD_KEY = /(^|_)(PROD|PRODUCTION|LIVE)(_|$)/;
const LIVE_VALUE = /\b(sk|rk|pk|whsec)_live_/;

/** NAME=VALUE pairs (comments, `export`, quotes handled). Values never leave this module. */
function parsePairs(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const stripped = line.replace(/^export\s+/, '');
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const name = stripped.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) continue;
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.push({ name, value });
  }
  return out;
}

/** The class of one key: prod by file name, key name or a live-mode value; remote when the value is a URL on another host. */
export function classifyEnvKey(file: string, name: string, value: string): EnvClass {
  const base = basename(file);
  if (PROD_FILE.test(base) || PROD_KEY.test(name.toUpperCase()) || LIVE_VALUE.test(value)) return 'prod';
  if (REMOTE_FILE.test(base) || pointsAtRemote(value)) return 'remote';
  return 'local';
}

/**
 * Every env value of 6 characters or more, held in this process only: the
 * plan scrubs them from any other string it prints (a CI step or a script can
 * repeat a value).
 */
export function envValues(root: string, fileList: string[]): Set<string> {
  const values = new Set<string>();
  for (const file of fileList.filter((f) => ENV_FILE.test(basename(f)))) {
    for (const { value } of parsePairs(readText(join(root, file)) ?? '')) {
      // A mode word or a number is no secret, and scrubbing it would garble commands.
      if (value.length >= 6 && !/^(true|false|development|production|staging|preview|test|debug|info|warning|\d+)$/i.test(value)) values.add(value);
    }
  }
  return values;
}

/** A deep copy of `data` where every string that contains one of `values` has it replaced by `<env value>`. */
export function scrubValues<T>(data: T, values: Set<string>): T {
  if (values.size === 0) return data;
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return JSON.parse(
    JSON.stringify(data, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      let out = value;
      for (const secret of sorted) if (out.includes(secret)) out = out.split(secret).join('<env value>');
      return out;
    }),
  ) as T;
}

export function scanEnv(root: string, fileList: string[]): EnvReport {
  const files: EnvFile[] = [];
  const schemes = new Set<string>();
  for (const file of fileList.filter((f) => ENV_FILE.test(basename(f)))) {
    const text = readText(join(root, file));
    if (text === null) continue;
    const base = basename(file);
    const example = EXAMPLE_FILE.test(base);
    const keysFile = base === '.env.keys';
    const keys = parsePairs(text).map(({ name, value }) => {
      const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
      if (scheme && !example && !['http', 'https'].includes(scheme)) schemes.add(scheme.replace(/\+.*$/, ''));
      return {
        name,
        class: keysFile ? (PROD_KEY.test(name.toUpperCase()) ? 'prod' : 'local') : classifyEnvKey(file, name, value),
        empty: value === '',
        encrypted: value.startsWith('encrypted:'),
      } satisfies EnvKey;
    });
    files.push({ file, example, dotenvx_keys: keysFile, keys });
  }
  const exampleOnly: EnvReport['example_only'] = [];
  for (const ex of files.filter((f) => f.example)) {
    const dir = dirname(ex.file);
    const setHere = new Set(
      files
        .filter((f) => !f.example && !f.dotenvx_keys && dirname(f.file) === dir)
        .flatMap((f) => f.keys.filter((k) => !k.empty).map((k) => k.name)),
    );
    for (const key of ex.keys) if (!setHere.has(key.name)) exampleOnly.push({ name: key.name, example: ex.file });
  }
  return { files, example_only: exampleOnly, schemes: [...schemes].sort() };
}

// ── Integrations ─────────────────────────────────────────────────────────────

export type IntegrationCategory =
  | 'code' | 'tracker' | 'chat' | 'errors' | 'analytics' | 'email' | 'crm' | 'support' | 'payments' | 'auth'
  | 'data' | 'hosting' | 'ai' | 'content' | 'recruiting' | 'flags' | 'jobs' | 'productivity';

export interface Integration {
  name: string;
  /** What kind of software it is: decides which loops can use it and which signals it can give. */
  category: IntegrationCategory;
  evidence: string[];
}

/** A third-party service the repository names (an env key) that no rule knows. The person says what it is. */
export interface UnrecognizedService {
  /** The key prefix, for example `ACME` for `ACME_API_KEY`. */
  prefix: string;
  evidence: string[];
}

interface Rule {
  name: string;
  category: IntegrationCategory;
  deps?: RegExp;
  files?: RegExp;
  keys?: RegExp;
  /** Text in docs and templates (README, CONTRIBUTING, .github/*.md). */
  links?: RegExp;
}

const PUB = '(NEXT_PUBLIC_|VITE_|PUBLIC_|EXPO_PUBLIC_|REACT_APP_)?';
const key = (names: string) => new RegExp(`^${PUB}(${names})(_|$)`);

// One rule per product. Order is the order `kortix plan` lists them in.
const RULES: Rule[] = [
  // Errors, logs, uptime
  { name: 'Sentry', category: 'errors', deps: /^(@sentry\/|sentry-sdk$|sentry-ruby$|raven$)/, files: /(^|\/)sentry\.[\w.-]*config\.(ts|js|mjs)$|(^|\/)\.sentryclirc$/, keys: key('SENTRY') },
  { name: 'Better Stack', category: 'errors', deps: /^(@logtail\/|@betterstack\/|logtail$)/, keys: key('BETTERSTACK|BETTER_STACK|LOGTAIL') },
  { name: 'Datadog', category: 'errors', deps: /^(dd-trace|datadog|ddtrace|@datadog\/)/, keys: key('DD|DATADOG') },
  { name: 'New Relic', category: 'errors', deps: /^(newrelic|@newrelic\/)/, files: /(^|\/)newrelic\.(js|yml|ini)$/, keys: key('NEW_RELIC|NEWRELIC') },
  { name: 'Honeycomb', category: 'errors', deps: /^(@honeycombio\/|honeycomb-beeline)/, keys: key('HONEYCOMB') },
  { name: 'Grafana', category: 'errors', deps: /^@grafana\//, keys: key('GRAFANA') },
  { name: 'LogRocket', category: 'errors', deps: /^logrocket/, keys: key('LOGROCKET') },
  { name: 'PagerDuty', category: 'errors', deps: /^(@pagerduty\/|pdpyras$|node-pagerduty$)/, keys: key('PAGERDUTY') },
  // Analytics
  { name: 'PostHog', category: 'analytics', deps: /^(posthog-js|posthog-node|posthog|posthog-react-native)$/, keys: /POSTHOG/ },
  { name: 'Google Analytics 4', category: 'analytics', deps: /^(react-ga4|@next\/third-parties|ga-4-react|vue-gtag)$/, keys: /(^|_)(GA|GA4|GTAG|GOOGLE_ANALYTICS)(_|$)|MEASUREMENT_ID/ },
  { name: 'Segment', category: 'analytics', deps: /^(@segment\/|analytics-node$|segment-analytics-python$)/, keys: key('SEGMENT') },
  { name: 'Mixpanel', category: 'analytics', deps: /^mixpanel/, keys: key('MIXPANEL') },
  { name: 'Amplitude', category: 'analytics', deps: /^(@amplitude\/|amplitude-js$|amplitude-analytics$)/, keys: key('AMPLITUDE') },
  { name: 'Plausible', category: 'analytics', deps: /^(plausible-tracker|next-plausible)$/, keys: key('PLAUSIBLE') },
  // Trackers
  { name: 'Linear', category: 'tracker', deps: /^@linear\/sdk$/, keys: key('LINEAR'), links: /linear\.app\// },
  { name: 'Jira', category: 'tracker', deps: /^(jira-client|jira\.js|jira)$/, keys: key('JIRA|ATLASSIAN'), links: /[\w-]+\.atlassian\.net\/(browse|jira)/ },
  { name: 'Asana', category: 'tracker', deps: /^asana$/, keys: key('ASANA'), links: /app\.asana\.com\// },
  { name: 'ClickUp', category: 'tracker', keys: key('CLICKUP'), links: /app\.clickup\.com\// },
  { name: 'Shortcut', category: 'tracker', deps: /^@shortcut\/client$/, keys: key('SHORTCUT'), links: /app\.shortcut\.com\// },
  { name: 'Trello', category: 'tracker', deps: /^trello/, keys: key('TRELLO'), links: /trello\.com\/b\// },
  { name: 'Notion', category: 'productivity', deps: /^(@notionhq\/client|notion-client)$/, keys: key('NOTION'), links: /notion\.so\// },
  // Chat
  { name: 'Slack', category: 'chat', deps: /^(@slack\/|slack-sdk$|slack_sdk$|slack-bolt$)/, keys: key('SLACK') },
  { name: 'Discord', category: 'chat', deps: /^(discord\.js|discord\.py|discord-interactions|@discordjs\/)/, keys: key('DISCORD') },
  { name: 'Telegram', category: 'chat', deps: /^(telegraf|node-telegram-bot-api|python-telegram-bot|grammy)$/, keys: key('TELEGRAM') },
  { name: 'Twilio', category: 'chat', deps: /^(twilio|@twilio\/)/, keys: key('TWILIO') },
  // Email
  { name: 'Resend', category: 'email', deps: /^resend$/, keys: key('RESEND') },
  { name: 'SendGrid', category: 'email', deps: /^(@sendgrid\/|sendgrid$)/, keys: key('SENDGRID') },
  { name: 'Postmark', category: 'email', deps: /^(postmark|postmarker)$/, keys: key('POSTMARK') },
  { name: 'Mailgun', category: 'email', deps: /^(mailgun\.js|mailgun-js|mailgun)$/, keys: key('MAILGUN') },
  { name: 'Loops', category: 'email', deps: /^loops$/, keys: key('LOOPS') },
  { name: 'Customer.io', category: 'email', deps: /^(customerio-node|customerio)$/, keys: key('CUSTOMERIO|CUSTOMER_IO|CIO') },
  { name: 'Mailchimp', category: 'email', deps: /^@mailchimp\//, keys: key('MAILCHIMP') },
  // CRM and sales
  { name: 'HubSpot', category: 'crm', deps: /^(@hubspot\/|hubspot-api-client$)/, keys: key('HUBSPOT') },
  { name: 'Salesforce', category: 'crm', deps: /^(jsforce|simple-salesforce|@salesforce\/)/, keys: key('SALESFORCE|SFDC') },
  { name: 'Attio', category: 'crm', deps: /^attio/, keys: key('ATTIO') },
  { name: 'Pipedrive', category: 'crm', deps: /^pipedrive$/, keys: key('PIPEDRIVE') },
  { name: 'Apollo', category: 'crm', keys: key('APOLLO_IO|APOLLOIO') },
  // Support
  { name: 'Plain', category: 'support', deps: /^@team-plain\//, keys: key('PLAIN') },
  { name: 'Intercom', category: 'support', deps: /^(@intercom\/|intercom-client$|react-use-intercom$)/, keys: /INTERCOM/ },
  { name: 'Zendesk', category: 'support', deps: /^(node-zendesk|zendesk)/, keys: key('ZENDESK') },
  { name: 'Front', category: 'support', keys: key('FRONTAPP|FRONT_API') },
  { name: 'Crisp', category: 'support', deps: /^(crisp-api|crisp-sdk-web)$/, keys: key('CRISP') },
  // Payments
  { name: 'Stripe', category: 'payments', deps: /^(stripe|@stripe\/)/, keys: key('STRIPE') },
  { name: 'Paddle', category: 'payments', deps: /^@paddle\//, keys: key('PADDLE') },
  { name: 'Lemon Squeezy', category: 'payments', deps: /^@lemonsqueezy\//, keys: key('LEMONSQUEEZY|LEMON_SQUEEZY') },
  { name: 'Polar', category: 'payments', deps: /^@polar-sh\//, keys: key('POLAR') },
  { name: 'Shopify', category: 'payments', deps: /^(@shopify\/|shopify-api-node$|ShopifyAPI$)/i, keys: key('SHOPIFY') },
  // Auth
  { name: 'Clerk', category: 'auth', deps: /^@clerk\//, keys: key('CLERK') },
  { name: 'Auth0', category: 'auth', deps: /^(@auth0\/|auth0$|auth0-python$)/, keys: key('AUTH0') },
  { name: 'WorkOS', category: 'auth', deps: /^(@workos-inc\/|workos$)/, keys: key('WORKOS') },
  // Data and backends
  { name: 'Supabase', category: 'data', deps: /^(@supabase\/|supabase$)/, files: /^supabase\/config\.toml$/, keys: key('SUPABASE') },
  { name: 'Convex', category: 'data', deps: /^(convex|@convex-dev\/)/, files: /^convex\.json$|^convex\/schema\.ts$/, keys: key('CONVEX') },
  { name: 'Firebase', category: 'data', deps: /^(firebase|firebase-admin|@firebase\/)/, files: /(^|\/)firebase\.json$/, keys: key('FIREBASE') },
  { name: 'Neon', category: 'data', deps: /^@neondatabase\//, keys: key('NEON') },
  { name: 'PlanetScale', category: 'data', deps: /^@planetscale\//, keys: key('PLANETSCALE') },
  { name: 'MongoDB', category: 'data', deps: /^(mongodb|mongoose|pymongo|motor)$/, keys: key('MONGO|MONGODB') },
  { name: 'Upstash', category: 'data', deps: /^@upstash\//, keys: key('UPSTASH') },
  { name: 'Algolia', category: 'data', deps: /^(algoliasearch|@algolia\/)/, keys: key('ALGOLIA') },
  { name: 'Pinecone', category: 'data', deps: /^(@pinecone-database\/|pinecone-client$|pinecone$)/, keys: key('PINECONE') },
  { name: 'Airtable', category: 'data', deps: /^(airtable|pyairtable)$/, keys: key('AIRTABLE') },
  // Hosting and cloud
  { name: 'Vercel', category: 'hosting', deps: /^@vercel\//, files: /(^|\/)vercel\.json$/, keys: key('VERCEL') },
  { name: 'Cloudflare', category: 'hosting', deps: /^(@cloudflare\/|wrangler$)/, files: /(^|\/)wrangler\.(toml|json|jsonc)$/, keys: key('CLOUDFLARE|CF') },
  { name: 'Netlify', category: 'hosting', deps: /^@netlify\//, files: /(^|\/)netlify\.toml$/, keys: key('NETLIFY') },
  { name: 'Fly.io', category: 'hosting', files: /(^|\/)fly\.toml$/, keys: key('FLY') },
  { name: 'Render', category: 'hosting', files: /(^|\/)render\.yaml$/, keys: key('RENDER') },
  { name: 'Railway', category: 'hosting', files: /(^|\/)railway\.(json|toml)$/, keys: key('RAILWAY') },
  { name: 'AWS', category: 'hosting', deps: /^(@aws-sdk\/|aws-sdk$|boto3$|aws-cdk-lib$|sst$)/, files: /(^|\/)(serverless\.ya?ml|samconfig\.toml|cdk\.json)$/, keys: key('AWS') },
  { name: 'Google Cloud', category: 'hosting', deps: /^(@google-cloud\/|google-cloud-)/, files: /(^|\/)(app\.yaml|cloudbuild\.ya?ml)$/, keys: key('GCP|GCLOUD|GOOGLE_CLOUD|GOOGLE_APPLICATION_CREDENTIALS') },
  { name: 'Azure', category: 'hosting', deps: /^(@azure\/|azure-)/, keys: key('AZURE') },
  { name: 'Expo', category: 'hosting', deps: /^(expo|eas-cli)$/, files: /(^|\/)eas\.json$/, keys: key('EXPO|EAS') },
  // AI
  { name: 'OpenAI', category: 'ai', deps: /^(openai|@ai-sdk\/openai)$/, keys: key('OPENAI') },
  { name: 'Anthropic', category: 'ai', deps: /^(@anthropic-ai\/|anthropic$|@ai-sdk\/anthropic$)/, keys: key('ANTHROPIC|CLAUDE') },
  { name: 'Google AI', category: 'ai', deps: /^(@google\/genai|@google\/generative-ai|google-genai|google-generativeai|@ai-sdk\/google)$/, keys: key('GEMINI|GOOGLE_GENERATIVE_AI') },
  { name: 'OpenRouter', category: 'ai', deps: /^@openrouter\//, keys: key('OPENROUTER') },
  { name: 'Replicate', category: 'ai', deps: /^replicate$/, keys: key('REPLICATE') },
  { name: 'ElevenLabs', category: 'ai', deps: /^(elevenlabs|@elevenlabs\/)/, keys: key('ELEVENLABS|ELEVEN_LABS') },
  // Content and design
  { name: 'Contentful', category: 'content', deps: /^contentful/, keys: key('CONTENTFUL') },
  { name: 'Sanity', category: 'content', deps: /^(@sanity\/|sanity$|next-sanity$)/, files: /(^|\/)sanity\.config\.(ts|js)$/, keys: key('SANITY') },
  { name: 'Figma', category: 'content', deps: /^(figma-api|@figma\/)/, keys: key('FIGMA') },
  // Feature flags and background jobs
  { name: 'LaunchDarkly', category: 'flags', deps: /^(launchdarkly-|@launchdarkly\/)/, keys: key('LAUNCHDARKLY|LD_SDK') },
  { name: 'Statsig', category: 'flags', deps: /^(statsig-|@statsig\/)/, keys: key('STATSIG') },
  { name: 'Inngest', category: 'jobs', deps: /^inngest$/, keys: key('INNGEST') },
  { name: 'Trigger.dev', category: 'jobs', deps: /^@trigger\.dev\//, files: /(^|\/)trigger\.config\.(ts|js)$/, keys: key('TRIGGER') },
  { name: 'Temporal', category: 'jobs', deps: /^(@temporalio\/|temporalio$)/, keys: key('TEMPORAL') },
  // Productivity and scheduling
  { name: 'Google Workspace', category: 'productivity', deps: /^(googleapis|google-api-python-client|@googleapis\/)/, keys: key('GOOGLE_CLIENT|GOOGLE_OAUTH|GMAIL|GOOGLE_CALENDAR|GOOGLE_DRIVE|GOOGLE_SHEETS') },
  { name: 'Cal.com', category: 'productivity', deps: /^@calcom\//, keys: key('CALCOM|CAL_COM') },
  { name: 'Calendly', category: 'productivity', keys: key('CALENDLY') },
  { name: 'Zoom', category: 'productivity', deps: /^@zoom\//, keys: key('ZOOM') },
  // Recruiting
  { name: 'Ashby', category: 'recruiting', keys: key('ASHBY'), links: /jobs\.ashbyhq\.com\// },
  { name: 'Greenhouse', category: 'recruiting', keys: key('GREENHOUSE'), links: /boards\.greenhouse\.io\// },
  { name: 'Lever', category: 'recruiting', keys: key('LEVER'), links: /jobs\.lever\.co\// },
  { name: 'Workable', category: 'recruiting', keys: key('WORKABLE'), links: /apply\.workable\.com\// },
];

/** A name the code or the CI reads from the environment, with the first file that reads it. */
export interface NamedEnv {
  name: string;
  file: string;
}

const CODE_FILE = /\.(m?[jt]sx?|cjs|py|rb|go|rs|php|java|kt|swift|ex|exs|cs)$/;
const ENV_READ = /(?:process\.env|import\.meta\.env|Bun\.env)(?:\.|\[["'])([A-Z][A-Z0-9_]{2,})|(?:os\.environ(?:\.get)?|os\.getenv|os\.Getenv|Deno\.env\.get|ENV(?:\.fetch)?|getenv|env::var|System\.getenv|env)\s*[(\[]\s*["']([A-Z][A-Z0-9_]{2,})["']/g;
const MAX_CODE_FILES = 3000;
const MAX_CODE_BYTES = 256 * 1024;

/**
 * Environment names the source code and the CI workflows read. A service the
 * code calls with `fetch` has no dependency and often no line in an env file:
 * the name it reads is the evidence. Names only, never a value.
 */
export function scanCodeEnvNames(root: string, fileList: string[], stack: StackReport): NamedEnv[] {
  const seen = new Map<string, string>();
  for (const file of fileList.filter((f) => CODE_FILE.test(f) && !/(^|\/)(dist|build|vendor|__generated__|_generated)\//.test(f)).slice(0, MAX_CODE_FILES)) {
    const abs = join(root, file);
    try {
      if (statSync(abs).size > MAX_CODE_BYTES) continue;
    } catch {
      continue;
    }
    for (const m of (readText(abs) ?? '').matchAll(ENV_READ)) {
      const name = m[1] ?? m[2]!;
      if (!seen.has(name)) seen.set(name, file);
    }
  }
  for (const ci of stack.ci) for (const name of ci.secrets) if (!seen.has(name)) seen.set(name, ci.workflow);
  return [...seen].map(([name, file]) => ({ name, file }));
}

/** Dependency names of the manifests npm does not cover: Python, Go, Ruby, Rust, PHP. */
function otherDeps(root: string, fileList: string[]): Array<{ file: string; dep: string }> {
  const out: Array<{ file: string; dep: string }> = [];
  const take = (file: string, re: RegExp) => {
    if (!fileList.includes(file)) return;
    for (const m of (readText(join(root, file)) ?? '').matchAll(re)) out.push({ file, dep: m[1]!.toLowerCase() });
  };
  take('requirements.txt', /^\s*([A-Za-z0-9_.-]+)/gm);
  take('pyproject.toml', /^\s*["']?([A-Za-z0-9_.-]+)\s*(?:[=<>~!\["']|$)/gm);
  take('Gemfile', /^\s*gem\s+["']([\w.-]+)["']/gm);
  take('go.mod', /^\s*(?:require\s+)?(?:github\.com\/)?([\w.\-/]+)\s+v\d/gm);
  take('Cargo.toml', /^\s*([\w-]+)\s*=/gm);
  take('composer.json', /"([\w.-]+\/[\w.-]+)"\s*:/g);
  return out;
}

export function scanIntegrations(root: string, fileList: string[], repo: RepositoryReport, env: EnvReport, named: NamedEnv[] = []): Integration[] {
  const pkgs = packageJsons(root, repo);
  const others = otherDeps(root, fileList);
  const docs = fileList.filter((f) => /^(README|CONTRIBUTING|AGENTS|CLAUDE)\.md$/i.test(f) || /^\.github\/.*\.md$/i.test(f));
  const docText = docs.map((doc) => ({ doc, text: readText(join(root, doc)) ?? '' }));
  const out: Integration[] = [];
  if (repo.github) out.push({ name: 'GitHub', category: 'code', evidence: [`origin: ${repo.github.owner}/${repo.github.repo}`] });
  for (const rule of RULES) {
    const evidence: string[] = [];
    if (rule.deps) {
      for (const { dir, pkg } of pkgs) {
        const hit = depsOf(pkg).find((dep) => rule.deps!.test(dep));
        if (hit) evidence.push(`${dir === '.' ? '' : `${dir}/`}package.json: ${hit}`);
      }
      const other = others.find(({ dep }) => rule.deps!.test(dep));
      if (other) evidence.push(`${other.file}: ${other.dep}`);
    }
    if (rule.files) for (const file of fileList.filter((f) => rule.files!.test(f)).slice(0, 3)) evidence.push(file);
    if (rule.keys) {
      for (const file of env.files) {
        const hit = file.keys.find((k) => rule.keys!.test(k.name));
        if (hit) evidence.push(`${file.file}: ${hit.name}`);
      }
    }
    if (rule.keys && evidence.length < 5) {
      const read = named.find((n) => rule.keys!.test(n.name) && !evidence.some((line) => line.endsWith(`: ${n.name}`)));
      if (read) evidence.push(`${read.file}: ${read.name}`);
    }
    if (rule.links) for (const { doc, text } of docText) if (rule.links.test(text)) evidence.push(doc);
    if (evidence.length > 0) out.push({ name: rule.name, category: rule.category, evidence: evidence.slice(0, 5) });
  }
  return out;
}

const CREDENTIAL_SUFFIX = /_(API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|WEBHOOK_SECRET|CLIENT_SECRET|CLIENT_ID|API_SECRET|TOKEN|SECRET|DSN|KEY)$/;
/** Prefixes that name the app's own plumbing, never a third party. */
const OWN_PREFIX = /^(APP|API|AUTH|NEXTAUTH|BETTER_AUTH|JWT|SESSION|COOKIE|CSRF|ENCRYPTION|ENCRYPT|SIGNING|ADMIN|INTERNAL|CRON|DATABASE|DB|POSTGRES|PG|MYSQL|REDIS|SECRET|PRIVATE|PUBLIC|MASTER|ROOT|SERVICE|SERVER|CLIENT|WEBHOOK|OAUTH|SMTP|S3|STORAGE|TEST|E2E|CI|NODE|DOTENV|KORTIX)$/;

/**
 * Credentials for a service no rule names: `ACME_API_KEY` reports `ACME`. The
 * setup agent asks the person what each one is, so no software is missed.
 */
export function scanUnrecognized(env: EnvReport, named: NamedEnv[] = []): UnrecognizedService[] {
  const byPrefix = new Map<string, string[]>();
  const inEnv = new Set(env.files.flatMap((file) => file.keys.map((k) => k.name)));
  const sources = [...env.files, ...named.filter((n) => !inEnv.has(n.name)).map((n) => ({ file: n.file, keys: [{ name: n.name }] }))];
  for (const file of sources) {
    for (const { name } of file.keys) {
      const bare = name.replace(new RegExp(`^${PUB}`), '');
      if (!CREDENTIAL_SUFFIX.test(bare) || RULES.some((rule) => rule.keys?.test(name))) continue;
      const prefix = bare.replace(CREDENTIAL_SUFFIX, '');
      if (!prefix || OWN_PREFIX.test(prefix)) continue;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), `${file.file}: ${name}`]);
    }
  }
  return [...byPrefix].map(([prefix, evidence]) => ({ prefix, evidence: evidence.slice(0, 3) }));
}

const MCP_CONFIG = /^(\.mcp\.json|\.cursor\/mcp\.json|\.vscode\/mcp\.json|\.codex\/config\.toml)$/;

/** MCP servers the repository's coding tools already use. Names only: a URL or an argument can hold a token. */
export function scanMcpServers(root: string, fileList: string[]): Array<{ name: string; file: string }> {
  const out: Array<{ name: string; file: string }> = [];
  for (const file of fileList.filter((f) => MCP_CONFIG.test(f))) {
    if (file.endsWith('.toml')) {
      for (const m of (readText(join(root, file)) ?? '').matchAll(/^\[mcp_servers\.([\w-]+)\]/gm)) out.push({ name: m[1]!, file });
      continue;
    }
    const json = readJson(join(root, file));
    const servers = (json?.mcpServers ?? json?.servers) as Record<string, unknown> | undefined;
    for (const name of Object.keys(servers ?? {})) out.push({ name, file });
  }
  return out;
}

// ── Dev environment proposal ─────────────────────────────────────────────────

export interface DevEnvProposal {
  base_image: string;
  runtimes: string[];
  system_packages: string[];
  container_runtime: boolean;
  services: string[];
  commands: { install: string | null; dev: string | null; test: string | null; e2e: string | null; typecheck: string | null; lint: string | null };
  /** The sandbox size for sandbox.templates (cpu, memory GiB, disk GiB), with the reason for each addition. */
  resources: { cpu: number; memory: number; disk: number; reasons: string[] };
}

/**
 * Size the sandbox from what runs in it. A trackstage run had ~1.5 GB free with
 * Vite, Convex and workerd up, and its worker crashed running the e2e suite.
 */
export function proposeResources(input: { browserTests: boolean; containerRuntime: boolean; services: number; workerd: boolean; monorepo: boolean }): DevEnvProposal['resources'] {
  const reasons = ['4 GB base: the agent, the dev server, the tests'];
  let memory = 4;
  if (input.browserTests) { memory += 2; reasons.push('+2 GB: browser tests'); }
  if (input.containerRuntime) { memory += 2; reasons.push('+2 GB: Docker in the sandbox'); }
  if (input.services > 0) { memory += input.services; reasons.push(`+${input.services} GB: ${input.services} local service${input.services === 1 ? '' : 's'}`); }
  if (input.workerd) { memory += 1; reasons.push('+1 GB: a Cloudflare worker runtime (workerd)'); }
  if (input.monorepo) { memory += 2; reasons.push('+2 GB: a monorepo'); }
  memory = Math.min(memory, 16);
  const cpu = memory >= 12 ? 8 : memory >= 8 ? 4 : 2;
  const disk = 20 + (input.browserTests ? 5 : 0) + (input.containerRuntime ? 10 : 0);
  return { cpu, memory, disk, reasons };
}

export function proposeDevEnv(stack: StackReport, env: EnvReport, detected: { workerd?: boolean } = {}): DevEnvProposal {
  const runtimes = stack.languages.map((l) => (l.version ? `${l.name} ${l.version}` : l.name));
  const pm = stack.package_managers[0]?.name ?? null;
  const run = (name: string) => {
    const hit = stack.commands.find((c) => c.package === '.' && (c.name === name || (name === 'typecheck' && c.name === 'type-check')));
    if (!hit) return null;
    return pm && ['pnpm', 'yarn', 'bun', 'npm'].includes(pm) ? `${pm === 'npm' ? 'npm run' : pm} ${hit.name}` : hit.command;
  };
  const install = pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --frozen-lockfile' : pm === 'bun' ? 'bun install' : pm === 'npm' ? 'npm ci' : pm === 'uv' ? 'uv sync' : pm === 'poetry' ? 'poetry install' : pm === 'pip' ? 'pip install -r requirements.txt' : pm === 'go' ? 'go mod download' : pm === 'cargo' ? 'cargo fetch' : null;
  const compose = stack.services.filter((s) => s.kind.startsWith('docker-compose'));
  const services = [
    ...compose.map((s) => `${s.name} (${s.evidence})`),
    ...stack.services.filter((s) => !s.kind.startsWith('docker-compose')).map((s) => s.kind),
    ...env.schemes.filter((s) => ['postgres', 'postgresql', 'mysql', 'redis', 'mongodb', 'amqp'].includes(s)).map((s) => `${s} (an env value expects it)`),
  ];
  const system = ['git', 'gh', 'curl', 'ca-certificates'];
  if (stack.browser_tests.length > 0) system.push('playwright browsers (npx playwright install --with-deps chromium)');
  if (env.schemes.includes('postgres') || env.schemes.includes('postgresql')) system.push('postgresql-client');
  return {
    base_image: stack.languages.some((l) => l.name === 'python') && !stack.languages.some((l) => l.name === 'node') ? 'python:<version>-bookworm' : 'debian:bookworm-slim (+ runtimes via mise)',
    runtimes,
    system_packages: system,
    container_runtime: compose.length > 0 || stack.services.some((s) => s.kind.startsWith('supabase')),
    services,
    commands: { install, dev: run('dev') ?? run('start'), test: run('test'), e2e: run('e2e') ?? run('test:e2e'), typecheck: run('typecheck'), lint: run('lint') },
    resources: proposeResources({
      browserTests: stack.browser_tests.length > 0,
      containerRuntime: compose.length > 0 || stack.services.some((s) => s.kind.startsWith('supabase')),
      services: services.length,
      workerd: detected.workerd === true || stack.commands.some((c) => /wrangler|workerd/.test(c.command)),
      monorepo: (stack as { monorepo?: { workspaces?: unknown[] } }).monorepo?.workspaces?.length ? true : false,
    }),
  };
}
