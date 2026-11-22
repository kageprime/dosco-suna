import { expect, test } from 'bun:test';
import { changeRequestReviewPath, normalizeChangeRequestRef } from './change-request-links';

const W = 'aaaaaaaa-1111-4111-8111-111111111111';
const C = 'bbbbbbbb-2222-4222-8222-222222222222';

test('a change request has one selectable Review URL, with encoded path and query', () => {
  expect(changeRequestReviewPath(W, C)).toBe(`/workspaces/${W}/review?id=cr%3A${C}`);
  expect(changeRequestReviewPath('workspace /?#', C)).toBe(`/workspaces/workspace%20%2F%3F%23/review?id=cr%3A${C}`);
});

test('the path selection wins while unrelated repeated query values survive', () => {
  const query = new URLSearchParams('tag=a&tag=b&id=cr:other&next=https://evil.test');
  const target = new URL(changeRequestReviewPath(W, C, query), 'https://kortix.test');
  expect(target.origin).toBe('https://kortix.test');
  expect(target.searchParams.getAll('tag')).toEqual(['a', 'b']);
  expect(target.searchParams.getAll('id')).toEqual([`cr:${C}`]);
  expect(query.get('id')).toBe('cr:other');
});

test.each([C, C.toUpperCase(), '233', '#233', '%23233', '000233', '2147483647'])('accepts supported reference %s', (ref) => {
  expect(normalizeChangeRequestRef(ref)).toBe(ref.includes('-') ? C : String(Number(decodeURIComponent(ref).replace(/^#/, ''))));
});

test.each(['', '0', '-1', '1.5', '1e2', '2147483648', '9999999999999999999', 'cr:233', 'a/b', '%23abc', '#', ' 233', '%', '%2523233', '%2F233'])('rejects malformed reference %s', (ref) => {
  expect(normalizeChangeRequestRef(ref)).toBeNull();
});
