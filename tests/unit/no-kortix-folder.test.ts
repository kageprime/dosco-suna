import { describe, expect, it } from 'vitest';
import { gitOrEmpty } from '../src/fixtures/git-or-empty';
import { readRepoFile } from '../src/fixtures/repo';

// A workspace repository has no `.kortix/` folder and none of the folders the
// OpenCode-era layout used (`.kortix/opencode/`, `harnesses/`, `.opencode/`).
// The layout is `packages/manifest-schema/src/layout.ts`: kortix.yaml,
// agents/, skills/, memory/, workflows/. On 2026-11-18 a new workspace still
// got `.kortix/link.json`: `kortix ship` wrote the CLI's link into the folder
// and committed it. The link now lives in the checkout's git config
// (apps/cli/src/project-link.ts); the CLI and kortixd tests prove nothing
// writes the folder. This test keeps the files a new workspace is made from,
// and the prompts that tell an agent where to write, off the old layout.

const OLD_FOLDER = /(^|\/)(\.kortix|\.opencode|harnesses)(\/|$)|(^|\/)opencode\.jsonc?$/;

// What an agent reads as an instruction. A mention of `.kortix/` here is an
// instruction to write there, except the one sentence that forbids it.
const AGENT_FACING = [
  'packages/shared/src/setup-guide.ts',
  'apps/api/src/projects/lib/my-kortix-prompt.ts',
  'apps/web/src/features/marketing/one-prompt/factory-content.ts',
  'packages/ui/src/session/agents/workflow-run-controls.tsx',
];
const FORBIDS_IT = /Never write a\s+\\`\.kortix\/\\` folder/g;

// Repositories made before 2026-09 keep their memory in `.kortix/memory/`, and
// the memory tool still reads it there. This line describes that older
// layout to the agent; it leaves with the old-layout readers.
const OLDER_LAYOUT_NOTES = new Set([
  'packages/starter/templates/managed/skills/kortix-memory/SKILL.md',
]);

function templateFiles(): string[] {
  return gitOrEmpty(['ls-files', 'packages/starter/templates']);
}

describe('no .kortix folder in a new workspace', () => {
  it('no template ships a file under an old-layout folder', () => {
    const files = templateFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((path) => OLD_FOLDER.test(path.slice('packages/starter/templates/'.length)))).toEqual([]);
  });

  it('no template text names a .kortix/ path, except the notes on the older memory layout', () => {
    const offenders = templateFiles()
      .filter((path) => !OLDER_LAYOUT_NOTES.has(path))
      .filter((path) => /\.(md|ya?ml|json|ts|js|sh|txt)$|(^|\/)\.gitignore$|Dockerfile$/.test(path))
      .filter((path) => /(^|[\s`'"(/])\.kortix\//.test(readRepoFile(path)));
    expect(offenders).toEqual([]);
  });

  it('no agent-facing prompt tells an agent to use .kortix/', () => {
    for (const path of AGENT_FACING) {
      const text = readRepoFile(path).replace(FORBIDS_IT, '');
      expect({ path, mentions: text.match(/\.kortix\/[\w.<>/-]*/g) ?? [] }).toEqual({ path, mentions: [] });
    }
  });
});
