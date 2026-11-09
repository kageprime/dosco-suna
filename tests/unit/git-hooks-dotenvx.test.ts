import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT as ROOT } from '../src/fixtures/repo';

// 2026-11-07: pre-commit ran `dotenvx protect` once the repo pinned dotenvx 2.x.
// `protect` blocks nothing and rewrites the GLOBAL git filter to the binary that
// ran it, a worktree's node_modules; removing that worktree makes `git add` of
// any `.env*` file fail on the whole machine.
const code = (hook: string) =>
  readFileSync(join(ROOT, '.githooks', hook), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));

describe('git hooks and dotenvx', () => {
  it.each(['pre-commit', 'pre-push'])('%s never runs `dotenvx protect`', (hook) => {
    expect(code(hook).filter((line) => /\bprotect\b/.test(line))).toEqual([]);
  });
});
