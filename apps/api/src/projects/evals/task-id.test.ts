import { describe, expect, test } from 'bun:test';
import { decodeTaskId, encodeTaskId } from './task-id';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const GIT = { kind: 'git' as const, git_url: 'https://github.com/example/tasks.git', commit: 'b'.repeat(40), path: 'tasks/hello' };

describe('eval task ids', () => {
  test('an id the API minted decodes back to its task, for its project only', () => {
    const repo = encodeTaskId(P1, { kind: 'repo', path: 'evals/smoke/hello' }, SHA);
    expect(decodeTaskId(P1, repo)).toEqual({ ref: { kind: 'repo', path: 'evals/smoke/hello' }, commit: SHA });
    expect(decodeTaskId(P1, encodeTaskId(P1, GIT, SHA))).toEqual({ ref: GIT, commit: GIT.commit });
    expect(decodeTaskId(P2, repo)).toBeNull();
  });

  test('a forged id naming another repository is no task', () => {
    const minted = encodeTaskId(P1, GIT, SHA);
    expect(minted).not.toContain('.');
    const [, signature] = minted.split('~');
    const forged = Buffer.from(JSON.stringify({ k: 'git', p: 'x', c: GIT.commit, u: 'https://github.com/attacker/huge.git' })).toString('base64url');
    expect(decodeTaskId(P1, `${forged}~${signature}`)).toBeNull();
    // Only `~` separates: the same signature after a `.` is no id.
    expect(decodeTaskId(P1, minted.replace('~', '.'))).toBeNull();
    // The unsigned format of before.
    expect(decodeTaskId(P1, forged)).toBeNull();
    expect(decodeTaskId(P1, `${minted}~x`)).toBeNull();
    expect(decodeTaskId(P1, '')).toBeNull();
  });

  test('the source label of a ref is not part of the id', () => {
    expect(encodeTaskId(P1, { ...GIT, source: 'terminal-bench@2.0' }, SHA)).toBe(encodeTaskId(P1, GIT, SHA));
  });
});
