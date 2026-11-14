import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { AGENTS_DIR, SKILLS_DIR } from '@kortix/manifest-schema/layout';

export type CodingAgent = 'claude' | 'codex' | 'pi' | 'cursor';

export const SUPPORTED_AGENTS: readonly CodingAgent[] = [
  'claude',
  'codex',
  'pi',
  'cursor',
] as const;

export const DEFAULT_PRIMARY: CodingAgent = 'codex';

/**
 * Path of the canonical Kortix skill, relative to repo root.
 *
 * `kortix-cli`, not `kortix-system`: the rest of the `kortix-*` family is
 * injected into sandboxes at boot rather than committed, so it is absent from a
 * local checkout — and this path is handed to LOCAL coding agents via the
 * generated AGENTS.md, where a dangling reference just wastes a file read.
 * `kortix-cli` ships in the scaffold and is the front door to the others.
 */
export const CANONICAL_SKILL = `${SKILLS_DIR}/kortix-cli/SKILL.md`;

/**
 * Native discovery paths each agent reads (the root project layout: `agents/`
 * and `skills/`):
 *
 *   .agents/skills → ../skills       (Codex: the cross-tool `.agents/skills`
 *                                     location, recursive)
 *   .claude/skills → ../skills
 *   .claude/agents → ../agents
 *   .pi/skills → ../skills
 *
 * Codex's documented project skills dir is `.agents/skills` (not `.codex/`).
 * Claude Code, Codex and Pi keep their local configuration in real `.claude`,
 * `.agents` and `.pi` directories; the CLI links only the discovery
 * subdirectories into them. Pi also reads a root `AGENTS.md`. Cursor has no
 * directory of its own and reads `AGENTS.md`.
 *
 * Note: Claude Code scans `.claude/skills` only one level deep, so skills nested
 * under a grouping folder (e.g. `<skill>/SKILL.md`) are
 * NOT discovered locally by Claude. They still load in the Kortix sandbox and
 * for Codex, both of which discover skills recursively.
 */
interface AgentLink {
  path: string;
  target: string;
}

const AGENT_LINKS: Partial<Record<CodingAgent, readonly AgentLink[]>> = {
  claude: [
    { path: '.claude/skills', target: `../${SKILLS_DIR}` },
    { path: '.claude/agents', target: `../${AGENTS_DIR}` },
  ],
  codex: [{ path: '.agents/skills', target: `../${SKILLS_DIR}` }],
  pi: [{ path: '.pi/skills', target: `../${SKILLS_DIR}` }],
};

export interface WireAgentsInput {
  repoRoot: string;
  agents: readonly CodingAgent[];
  overwrite: boolean;
  /**
   * The skills `kortix.yaml` registers: name → path from the repository root.
   * When the root has no `skills/` folder, each one is linked on its own, so a
   * skill under `.kortix/` reaches the local tools too.
   */
  skills?: Record<string, string>;
  /** The repository had an `AGENTS.md` of its own: keep it and add a Kortix section. */
  keepAgentsMd?: boolean;
}

export interface WireAgentsResult {
  written: string[];
  skipped: string[];
}

/**
 * Wire each selected local coding tool to the starter's canonical skill source.
 * Claude Code, Codex, and Pi get native discovery links.
 * Codex, Pi, and Cursor also get a root `AGENTS.md` pointer.
 */
export function wireCodingAgents(input: WireAgentsInput): WireAgentsResult {
  const written: string[] = [];
  const skipped: string[] = [];
  let wantAgentsMd = false;
  const isDir = (path: string) => statSync(resolve(input.repoRoot, path), { throwIfNoEntry: false })?.isDirectory() === true;
  // Skills registered outside the root `skills/` folder get one link each.
  const registered = Object.entries(input.skills ?? {}).filter(([, path]) => isDir(path));
  const perSkill = !isDir(SKILLS_DIR) && registered.length > 0;

  const link = (path: string, target: string) => {
    const abs = resolve(input.repoRoot, path);
    try {
      mkdirSync(dirname(abs), { recursive: true });
    } catch (err) {
      skipped.push(`${path} (parent unavailable: ${(err as Error).message})`);
      return;
    }
    if (!handleExisting(abs, input.overwrite)) {
      skipped.push(path);
      return;
    }
    try {
      symlinkSync(target, abs);
      written.push(`${path} → ${target}`);
    } catch (err) {
      // Symlinks need elevated privileges on some platforms (e.g. Windows
      // without Developer Mode). Never fail init over it — just note it.
      skipped.push(`${path} (symlink unsupported: ${(err as Error).message})`);
    }
  };

  for (const agent of input.agents) {
    for (const entry of AGENT_LINKS[agent] ?? []) {
      const source = entry.target.replace(/^\.\.\//, '');
      if (source === SKILLS_DIR && perSkill) {
        // A dangling `skills` link from an earlier run would swallow the per-skill links.
        dropDangling(resolve(input.repoRoot, entry.path));
        for (const [name, path] of registered) {
          link(`${entry.path}/${name}`, relative(resolve(input.repoRoot, entry.path), resolve(input.repoRoot, path)));
        }
      } else if (isDir(source) || !input.keepAgentsMd) {
        link(entry.path, entry.target);
      } else {
        // In a repository that already exists, a link to a folder it does not have would dangle: remove an old one.
        dropDangling(resolve(input.repoRoot, entry.path));
      }
    }
    if (agent === 'codex' || agent === 'pi' || agent === 'cursor') wantAgentsMd = true;
  }

  // AGENTS.md is loaded by Codex, Pi, and Cursor. Write it once.
  if (wantAgentsMd) {
    const abs = resolve(input.repoRoot, 'AGENTS.md');
    const current = existsSync(abs) && !lstatSync(abs).isDirectory() ? readFileSync(abs, 'utf8') : null;
    if (current !== null && input.keepAgentsMd && current !== AGENTS_POINTER) {
      // The file is the person's: never replace it. One marked section, written once.
      if (current.includes(SECTION_START)) skipped.push('AGENTS.md');
      else {
        appendFileSync(abs, `${current.endsWith('\n') ? '' : '\n'}\n${AGENTS_SECTION}`, 'utf8');
        written.push('AGENTS.md (Kortix section added, the rest kept)');
      }
    } else if (handleExisting(abs, input.overwrite)) {
      writeFileSync(abs, AGENTS_POINTER, 'utf8');
      written.push('AGENTS.md');
    } else {
      skipped.push('AGENTS.md');
    }
  }

  return { written, skipped };
}

/** Remove `abs` when it is a symlink whose target is gone. */
function dropDangling(abs: string): void {
  if (lstatSync(abs, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(abs)) rmSync(abs, { force: true });
}

/** Return true if it's OK to (over)write at `abs`. */
function handleExisting(abs: string, overwrite: boolean): boolean {
  let st;
  try {
    st = lstatSync(abs, { throwIfNoEntry: false } as any) as ReturnType<typeof lstatSync> | undefined;
  } catch {
    st = undefined;
  }
  if (!st && !existsSync(abs)) return true;
  if (st?.isDirectory()) return false;
  if (overwrite) {
    // Remove a stale symlink or file. Preserve real directories.
    rmSync(abs, { force: true, recursive: false });
    return true;
  }
  return false;
}

const AGENTS_POINTER = `# Kortix workspace

This repository is a [Kortix](https://kortix.ai) workspace. The manifest is
\`kortix.yaml\`: it registers the skills, tools, commands and extensions, and
declares each agent. Agent prompts live in \`${AGENTS_DIR}/\`, skills in
\`${SKILLS_DIR}/\`.
The skills are available through each wired tool's native discovery location.

Whenever the user asks about Kortix — \`kortix.yaml\`, triggers, secrets, the
sandbox image, sessions, connectors, or Claude Code, Codex, and Pi
configuration — run \`kortix skills get kortix-cli\` first. It is the
canonical reference.

For any other task, proceed normally.
`;

const SECTION_START = '<!-- kortix:start -->';

/** The section added to an `AGENTS.md` the repository already had. */
const AGENTS_SECTION = `${SECTION_START}
## Kortix

\`kortix.yaml\` in this repository defines the agents, triggers, skills and
connectors that run on Kortix. Whenever the task touches Kortix, run
\`kortix skills get kortix-cli\` first: it is the canonical reference.
<!-- kortix:end -->
`;
