/**
 * `kortix tools` — the tools this project's sessions get, read from the local
 * kortix.yaml and its imports, and `eject`, which turns a Kortix tool into a
 * project tool the project owns.
 *
 * With no local kortix.yaml (a session sandbox without a checkout), `ls` reads
 * the manifest and its imports from the workspace repository through the same
 * `GET /workspaces/:id/files/content` route `kortix files cat` uses.
 *
 *   kortix tools ls [--json]          name, kind, source; and the removed Kortix tools
 *   kortix tools eject <name>         tools/<name>.ts + `tools.<name>: tools/<name>.ts`
 *
 * Every Kortix tool is always registered; `tools:` maps a name to a project
 * module, and a Kortix tool's name replaces that tool. The ejected source is
 * the daemon's own module, embedded in `kortix-tools.generated.json`.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  HARNESS_TOOL_NAMES,
  KORTIX_TOOL_NAMES,
  ManifestImportError,
  type ManifestImportReader,
  TOOL_NAME_RE,
  manifestCandidatePaths,
  parseManifestText,
  resolveManifestImports,
  safeToolFile,
} from '@kortix/manifest-schema';
import { ApiError, type ApiClient } from '../api/client.ts';
import { splitHelp } from '../command-argv.ts';
import { emitJson, resolveProjectContext, surfaceApiError, takeFlagBool, takeFlagValue } from '../command-helpers.ts';
import KORTIX_TOOL_SOURCES from '../kortix-tools.generated.json' with { type: 'json' };
import { resolveLocalManifestImports } from '../manifest-imports.ts';
import { setYamlMapEntry } from '../manifest-edit.ts';
import { resolveLocalManifest } from '../manifest.ts';
import { C, help, pad, status } from '../style.ts';

const HELP = help`Usage: kortix tools <subcommand> [options]

The tools this workspace's sessions get, from ./kortix.yaml \`tools:\` and its
imports. Kortix maintains these tools: ${KORTIX_TOOL_NAMES.join(', ')}.
Every Kortix tool is always registered. \`tools:\` maps a name to a workspace
module (\`<name>: <path to a .ts or .js module>\`), and a Kortix tool's name
replaces that tool.

Subcommands:
  ls [--json] [--ref <ver>] List each tool the sessions get: name, kind
                            (kortix, kortix (overridden), workspace) and source.
                            Reads ./kortix.yaml. Without one (a session with no
                            checkout), or with --workspace or --ref, reads
                            kortix.yaml and its imports from the workspace
                            repository, as \`kortix files cat kortix.yaml\` does.
  eject <name> [--force]    Copy the Kortix tool <name> to tools/<name>.ts and
                            set \`tools.<name>: tools/<name>.ts\` in kortix.yaml.
                            The copy is yours to change; Kortix no longer
                            updates it. Refuses when tools/<name>.ts exists.

Options:
  --json              ls: machine-readable output.
  --ref <ver>         ls: the version (branch) to read when there is no local
                      kortix.yaml. Default: the workspace's default branch.
  --force             eject: overwrite tools/<name>.ts.
  --workspace <id>    ls: the workspace to read when there is no local
                      kortix.yaml (default: linked, or the session's).
  --host <name>       ls: the Kortix host of that workspace.
  -h, --help          Show this help.

Limit the tools of one agent: \`agents.<name>.tools\` in kortix.yaml
(\`tools: { exclude: [web_search] }\`).
`;

type ToolKind = 'kortix' | 'kortix (overridden)' | 'project';

interface ToolRow {
  name: string;
  kind: ToolKind;
  source: string;
}

const isKortixTool = (name: string) => (KORTIX_TOOL_NAMES as readonly string[]).includes(name);

/**
 * What a session of this manifest loads, as the API compiles it
 * (compile-agent-config.ts `compileTools`): every Kortix tool, replaced by the
 * project module that `tools.<name>` names, then the project's own tools.
 */
export function listTools(raw: Record<string, unknown>): ToolRow[] {
  const tools = raw.tools;
  const map = tools && typeof tools === 'object' && !Array.isArray(tools) ? (tools as Record<string, unknown>) : {};
  const rows: ToolRow[] = KORTIX_TOOL_NAMES.map((name) => {
    const path = safeToolFile(map[name]);
    return path ? { name, kind: 'kortix (overridden)', source: path } : { name, kind: 'kortix', source: `kortix:${name}` };
  });
  for (const [name, value] of Object.entries(map)) {
    const path = safeToolFile(value);
    const reserved = (HARNESS_TOOL_NAMES as readonly string[]).includes(name) || name.startsWith('pty_');
    if (!isKortixTool(name) && path && TOOL_NAME_RE.test(name) && !reserved) rows.push({ name, kind: 'project', source: path });
  }
  return rows;
}

/** The local manifest, merged with its imports, or an exit code after printing why not. */
function readManifest(): { file: string; raw: Record<string, unknown>; origins: Record<string, string> } | number {
  const found = resolveLocalManifest(process.cwd());
  if (!found) {
    process.stderr.write(`${status.err('Manifest not found')}\n  ${C.dim}Run from your workspace root (the folder with kortix.yaml).${C.reset}\n`);
    return 2;
  }
  try {
    const resolved = resolveLocalManifestImports(found.path);
    return { file: found.path, raw: resolved.raw, origins: resolved.origins.tools };
  } catch (err) {
    const detail = err instanceof ManifestImportError ? err.message : `cannot parse ${found.path}: ${(err as Error).message}`;
    process.stderr.write(`${status.err(detail)}\n  ${C.dim}Run \`kortix validate\` for the full report.${C.reset}\n`);
    return 1;
  }
}

/** Where `ls` reads the workspace manifest when there is no local checkout. */
interface RemoteOpts {
  projectArg?: string;
  hostArg?: string;
  ref?: string;
}

/** The repository-backed import reader: the same files the API resolves `imports:` from. */
function remoteImportReader(client: ApiClient, base: string, refQ: string): ManifestImportReader {
  const read = async (path: string) =>
    (await client.get<{ content: string }>(`${base}/files/content?path=${encodeURIComponent(path)}${refQ}`)).content;
  return {
    async list(path) {
      const entries = await client.get<Array<{ path: string }>>(`${base}/files?path=${encodeURIComponent(path)}${refQ}`);
      if (entries.length > 0) return entries.map((entry) => ({ path: entry.path }));
      // A file path lists nothing on some stores: a readable file is its own entry.
      try {
        await read(path);
        return [{ path }];
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }
    },
    read,
  };
}

/**
 * The workspace repository's manifest, merged with its imports, or an exit
 * code after printing why not. Tries the same names as a checkout
 * (kortix.yaml, then kortix.yml).
 */
async function readRemoteManifest(
  opts: RemoteOpts,
): Promise<{ file: string; workspaceId: string; ref: string | null; raw: Record<string, unknown> } | number> {
  const ctx = await resolveProjectContext({ projectArg: opts.projectArg, hostArg: opts.hostArg });
  if (!ctx) {
    process.stderr.write(
      `${status.err('Manifest not found')}\n  ${C.dim}No ./kortix.yaml here, and no workspace to read it from. Run from your workspace root (the folder with kortix.yaml), or pass --workspace <id>.${C.reset}\n`,
    );
    return 2;
  }
  const base = `/workspaces/${ctx.projectId}`;
  const refQ = opts.ref ? `&ref=${encodeURIComponent(opts.ref)}` : '';
  try {
    for (const file of manifestCandidatePaths()) {
      let text: string;
      try {
        text = (await ctx.client.get<{ content: string }>(`${base}/files/content?path=${encodeURIComponent(file)}${refQ}`)).content;
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) continue;
        throw err;
      }
      let raw: Record<string, unknown>;
      try {
        raw = parseManifestText(text);
      } catch (err) {
        process.stderr.write(`${status.err(`cannot parse ${file} in workspace ${ctx.projectId}: ${(err as Error).message}`)}\n`);
        return 1;
      }
      const resolved = await resolveManifestImports({ path: file, raw }, remoteImportReader(ctx.client, base, refQ));
      return { file, workspaceId: ctx.projectId, ref: opts.ref ?? null, raw: resolved.raw };
    }
  } catch (err) {
    if (err instanceof ManifestImportError) {
      process.stderr.write(`${status.err(err.message)}\n`);
      return 1;
    }
    return surfaceApiError(err);
  }
  process.stderr.write(
    `${status.err('Manifest not found')}\n  ${C.dim}No ./kortix.yaml here, and workspace ${ctx.projectId} has no kortix.yaml${opts.ref ? ` on ${opts.ref}` : ''}.${C.reset}\n`,
  );
  return 2;
}

async function toolsLs(json: boolean, remote: RemoteOpts): Promise<number> {
  let file: string;
  let raw: Record<string, unknown>;
  let origin: { source: 'local' } | { source: 'workspace'; workspace_id: string; ref: string | null };
  // An explicit --workspace or --ref names the repository copy; otherwise a checkout wins.
  const wantsRemote = remote.projectArg !== undefined || remote.ref !== undefined;
  if (!wantsRemote && resolveLocalManifest(process.cwd())) {
    const manifest = readManifest();
    if (typeof manifest === 'number') return manifest;
    ({ file, raw } = manifest);
    origin = { source: 'local' };
  } else {
    const manifest = await readRemoteManifest(remote);
    if (typeof manifest === 'number') return manifest;
    ({ file, raw } = manifest);
    origin = { source: 'workspace', workspace_id: manifest.workspaceId, ref: manifest.ref };
  }
  const tools = listTools(raw);
  if (json) {
    emitJson({ manifest: file, ...origin, tools });
    return 0;
  }
  if (origin.source === 'workspace') {
    process.stdout.write(`${C.dim}From ${file} in workspace ${origin.workspace_id}${origin.ref ? ` (${origin.ref})` : ''}: no local kortix.yaml.${C.reset}\n`);
  }
  const nameWidth = Math.max(4, ...tools.map((row) => row.name.length)) + 2;
  const kindWidth = Math.max(4, ...tools.map((row) => (row.kind === 'project' ? 'workspace' : row.kind).length)) + 2;
  process.stdout.write(`${C.dim}${pad('NAME', nameWidth)}${pad('KIND', kindWidth)}SOURCE${C.reset}\n`);
  // `project` is the manifest kind (kept in --json); the table says workspace.
  for (const row of tools) process.stdout.write(`${pad(row.name, nameWidth)}${pad(row.kind === 'project' ? 'workspace' : row.kind, kindWidth)}${row.source}\n`);
  return 0;
}

function toolsEject(name: string | undefined, force: boolean): number {
  if (!name || !isKortixTool(name)) {
    process.stderr.write(
      `${status.err(name ? `"${name}" is not a Kortix tool.` : 'Name the Kortix tool to eject.')}\n` +
        `  ${C.dim}Eject one of: ${KORTIX_TOOL_NAMES.join(', ')}.${C.reset}\n`,
    );
    return 2;
  }
  if (!resolveLocalManifest(process.cwd())) {
    process.stderr.write(
      `${status.err('Manifest not found')}\n  ${C.dim}eject writes tools/${name}.ts into a checkout: run it from your workspace root (the folder with kortix.yaml).${C.reset}\n`,
    );
    return 2;
  }
  const manifest = readManifest();
  if (typeof manifest === 'number') return manifest;
  const root = dirname(manifest.file);
  const target = `tools/${name}.ts`;
  const map = manifest.raw.tools && typeof manifest.raw.tools === 'object' ? (manifest.raw.tools as Record<string, unknown>) : {};
  const current = map[name];
  const owned = safeToolFile(current);
  if (!force && owned && owned !== target) {
    process.stderr.write(
      `${status.err(`${name} is already the workspace's own module: ${owned}.`)}\n  ${C.dim}Pass --force to replace it with a fresh copy at ${target}.${C.reset}\n`,
    );
    return 1;
  }
  if (!force && existsSync(resolve(root, target))) {
    process.stderr.write(`${status.err(`${target} exists.`)}\n  ${C.dim}Pass --force to overwrite it with the Kortix source.${C.reset}\n`);
    return 1;
  }

  mkdirSync(resolve(root, 'tools'), { recursive: true });
  writeFileSync(resolve(root, target), (KORTIX_TOOL_SOURCES as Record<string, string>)[name]!, 'utf8');

  // The file that declares the entry gets the edit; a new entry goes to the root manifest.
  const declaring = manifest.origins[name] ? resolve(root, manifest.origins[name]!) : manifest.file;
  const comment = `ejected from kortix:${name}`;
  setYamlMapEntry(declaring, 'tools', name, target, comment);

  const edited = relative(root, declaring);
  process.stdout.write(`${status.ok(`Ejected ${name}`)}\n`);
  process.stdout.write(`  ${C.dim}wrote${C.reset}   ${target} ${C.dim}(the Kortix source, now the workspace's to change)${C.reset}\n`);
  process.stdout.write(`  ${C.dim}set${C.reset}     ${edited}: tools.${name}: ${target}\n`);
  process.stdout.write(
    `\nNext:\n` +
      `  1. Edit ${target}. Keep the default export: { description, parameters, execute(args, context) }.\n` +
      `  2. kortix validate\n` +
      `  3. git add ${target} ${edited} && git commit -m "Own the ${name} tool"\n` +
      `  4. Open a change request: git push origin HEAD && kortix cr open --title "Own the ${name} tool"\n` +
      `${C.dim}Sessions load the copy after the change request merges.${C.reset}\n`,
  );
  return 0;
}

export async function runTools(argv: string[]): Promise<number> {
  const helpCode = splitHelp(argv, HELP);
  if (helpCode !== null) return helpCode;
  const [sub, ...rest] = argv;
  const json = takeFlagBool(rest, ['--json']);
  const force = takeFlagBool(rest, ['--force']);
  const remote: RemoteOpts = {};
  try {
    remote.projectArg = takeFlagValue(rest, ['--project', '--workspace']);
    remote.hostArg = takeFlagValue(rest, ['--host']);
    remote.ref = takeFlagValue(rest, ['--ref']);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  const unknown = rest.find((arg) => arg.startsWith('-'));
  if (unknown) {
    process.stderr.write(`unknown option "${unknown}"\n\n${HELP}`);
    return 2;
  }
  switch (sub) {
    case 'ls':
    case 'list':
      return toolsLs(json, remote);
    case 'eject':
      return toolsEject(rest[0], force);
    default:
      process.stderr.write(`unknown subcommand "${sub}"\n\n${HELP}`);
      return 2;
  }
}
