import { describe, expect, test } from 'bun:test';
import {
  parseWorktreePorcelain, isClaudeWorktree, parseClaudeLock, lockState, procStatStart,
  mergedPrIndex, prCovering, decideBranch, AGENT_BRANCH,
} from '../lib';

const PORCELAIN = [
  'worktree /w/suna', 'HEAD aaa', 'branch refs/heads/dev', '',
  'worktree /w/suna-feat', 'HEAD bbb', 'branch refs/heads/feat', '',
  'worktree /w/suna/.claude/worktrees/agent-a97', 'HEAD ccc', 'branch refs/heads/worktree-agent-a97',
  'locked claude agent agent-a97 (pid 1835031 start 8273696)', '',
  'worktree /tmp/scratch/probe', 'HEAD ddd', 'detached', 'locked', 'prunable gitdir file points to non-existent location', '',
].join('\n');

describe('git worktree list --porcelain', () => {
  test('paths, branches, lock reasons, detached and prunable entries', () => {
    expect(parseWorktreePorcelain(PORCELAIN)).toEqual([
      { path: '/w/suna', head: 'aaa', branch: 'dev' },
      { path: '/w/suna-feat', head: 'bbb', branch: 'feat' },
      { path: '/w/suna/.claude/worktrees/agent-a97', head: 'ccc', branch: 'worktree-agent-a97', locked: 'claude agent agent-a97 (pid 1835031 start 8273696)' },
      { path: '/tmp/scratch/probe', head: 'ddd', locked: '', prunable: true },
    ]);
  });
  test('only direct children of <primary>/.claude/worktrees are Claude isolation worktrees', () => {
    expect(isClaudeWorktree('/w/suna/.claude/worktrees/agent-a97', '/w/suna')).toBe(true);
    expect(isClaudeWorktree('/w/suna/.claude/worktrees/agent-a97', '/w/suna/')).toBe(true);
    expect(isClaudeWorktree('/w/suna/.claude/worktrees/', '/w/suna')).toBe(false);
    expect(isClaudeWorktree('/w/suna/.claude/worktrees/a/b', '/w/suna')).toBe(false);
    expect(isClaudeWorktree('/w/suna-feat', '/w/suna')).toBe(false);
    expect(isClaudeWorktree('/w/suna-x/.claude/worktrees/agent-1', '/w/suna')).toBe(false);
  });
});

describe('Claude agent lock', () => {
  const reason = 'claude agent agent-a97 (pid 1835031 start 8273696)';
  test('parses pid and start ticks; any other reason is not a Claude lock', () => {
    expect(parseClaudeLock(reason)).toEqual({ pid: 1835031, start: '8273696' });
    expect(parseClaudeLock('keep: release branch')).toBeNull();
    expect(parseClaudeLock(undefined)).toBeNull();
  });
  test('agent running only when the pid lives with the same start time', () => {
    expect(lockState(undefined, () => null)).toBe('none');
    expect(lockState(reason, () => '8273696')).toBe('agent-running');
    expect(lockState(reason, () => '9999999')).toBe('agent-gone');
    expect(lockState(reason, () => null)).toBe('agent-gone');
    expect(lockState(reason, () => undefined)).toBe('agent-running');
  });
  test('a lock a person set is honored', () => {
    expect(lockState('', () => null)).toBe('other');
    expect(lockState('do not touch', () => null)).toBe('other');
  });
  test('/proc/<pid>/stat start time is field 22, comm may hold spaces and parens', () => {
    const rest = Array.from({ length: 25 }, (_, i) => String(i + 3)).join(' ');
    expect(procStatStart(`1835031 (claude (x) y) ${rest}`)).toBe('22');
    expect(procStatStart('garbage')).toBeNull();
  });
});

describe('merged PR detection', () => {
  const idx = mergedPrIndex(JSON.stringify([
    { number: 12258, headRefName: 'worktree-autoclean', headRefOid: 'tip1' },
    { number: 12001, headRefName: 'reused', headRefOid: 'old' },
    { bogus: true },
  ]));
  test('index by head branch; malformed rows and bad JSON are ignored', () => {
    expect(idx.get('worktree-autoclean')?.[0]?.number).toBe(12258);
    expect(idx.size).toBe(2);
    expect(mergedPrIndex('not json').size).toBe(0);
  });
  test('the PR head is the tip: merged', () => {
    expect(prCovering(idx.get('worktree-autoclean'), 'tip1', () => null)?.number).toBe(12258);
  });
  test('tip behind the PR head, or ahead only by pushed commits: merged', () => {
    expect(prCovering(idx.get('reused'), 'tip2', () => 0)?.number).toBe(12001);
  });
  test('a reused branch name with new unpushed work: not merged', () => {
    expect(prCovering(idx.get('reused'), 'tip2', () => 3)).toBeNull();
    expect(prCovering(idx.get('reused'), 'tip2', () => null)).toBeNull();
    expect(prCovering(undefined, 'tip2', () => 0)).toBeNull();
  });
});

describe('leftover worktree-agent-* branches', () => {
  const b = (o: Partial<Parameters<typeof decideBranch>[0]> = {}) => decideBranch({ name: 'worktree-agent-a0afa76b4680425a4', checkedOut: false, unpushed: 0, merged: false, ...o });
  test('no worktree and every commit on a remote: delete', () => {
    expect(b().remove).toBe(true);
  });
  test('commits on no remote: keep, unless merged into dev', () => {
    expect(b({ unpushed: 1 }).remove).toBe(false);
    expect(b({ unpushed: 1, merged: true }).remove).toBe(true);
    expect(b({ unpushed: null }).remove).toBe(false);
  });
  test('a branch a worktree has checked out is kept', () => {
    expect(b({ checkedOut: true }).remove).toBe(false);
    expect(b({ checkedOut: true, merged: true }).remove).toBe(false);
  });
  test('any other branch name is never touched', () => {
    expect(b({ name: 'dev' }).remove).toBe(false);
    expect(b({ name: 'worktree-agent-x/feature' }).remove).toBe(false);
    expect(AGENT_BRANCH.test('worktree-agent-a9726829de874542f')).toBe(true);
  });
});
