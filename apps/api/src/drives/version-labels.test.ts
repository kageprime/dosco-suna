// The versions list reads the same for a block volume as before, and a shared
// volume's own versions (`api`, `sync`, `auto`) read naturally. An unknown kind
// or a missing author never fails the list.
import { expect, test } from 'bun:test';
import { versionAuthor, versionKind } from './version-labels';

const commit = (kind: unknown, author?: unknown) => ({ kind, author }) as never;

test('a block volume\'s commits read as they always did', () => {
  expect(['init', 'fork', 'restore', 'api', 'import', 'merge', 'fast', 'commit'].map(versionKind)).toEqual(
    ['created', 'created', 'restore', 'edit', 'edit', 'sync', 'sync', 'sync'],
  );
  expect(versionAuthor(commit('api', { kind: 'api_key', id: null }))).toBe('drive');
  expect(versionAuthor(commit('api', { kind: 'user', id: 'u' }))).toBe('drive');
  expect(versionAuthor(commit('commit', { kind: 'sandbox', id: 's' }))).toBe('session');
  expect(versionAuthor(commit('merge', { kind: 'system', id: null }))).toBe('session');
  expect(versionAuthor(commit('init', { kind: 'system', id: null }))).toBe('system');
});

test('a shared volume\'s versions: an edit by the drive, a session\'s sync, storage\'s own', () => {
  expect([versionKind('api'), versionAuthor(commit('api', { kind: 'api_key', id: null }))]).toEqual(['edit', 'drive']);
  expect([versionKind('sync'), versionAuthor(commit('sync', { kind: 'sandbox', id: null }))]).toEqual(['sync', 'session']);
  expect([versionKind('auto'), versionAuthor(commit('auto', { kind: 'system', id: null }))]).toEqual(['sync', 'system']);
  // Without an author, the kind says who.
  expect(versionAuthor(commit('sync'))).toBe('session');
  expect(versionAuthor(commit('api', null))).toBe('drive');
  expect(versionAuthor(commit('auto'))).toBe('system');
});

test('an unknown kind or author never fails: it reads as a sync by the system', () => {
  expect(versionKind('something-new')).toBe('sync');
  expect(versionKind(undefined)).toBe('sync');
  expect(versionKind(42)).toBe('sync');
  expect(versionAuthor(commit('something-new', { kind: 'robot' }))).toBe('system');
  expect(versionAuthor(commit(undefined, { kind: 7 }))).toBe('system');
});
