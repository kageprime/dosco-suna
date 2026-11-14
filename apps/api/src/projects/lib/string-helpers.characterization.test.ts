import { describe, expect, test } from 'bun:test';
import { sessionAgentHandle } from './session-board';
import { privateSpaceText } from './session-where';
import { normalizeRuntimeSessionSnapshot } from './runtime-session-snapshot';

// Pins the behavior of the three string helpers through boundaries that
// already existed before they were shared, so the test passes before and after.
describe('shared string helpers, through their existing callers', () => {
  test('oneLine (via privateSpaceText) collapses whitespace and ellipsizes at 40', () => {
    expect(privateSpaceText('  Sales \n\t Bot  ')).toBe("the person's private space with Sales Bot");
    expect(privateSpaceText('x'.repeat(41))).toBe(`the person's private space with ${'x'.repeat(39)}…`);
    expect(privateSpaceText('x'.repeat(40))).toBe(`the person's private space with ${'x'.repeat(40)}`);
  });

  test('metaString (via sessionAgentHandle) returns a non-empty string as stored', () => {
    expect(sessionAgentHandle({ agent_handle: ' v ' })).toBe(' v ');
    expect(sessionAgentHandle({ agent_handle: '   ' })).toBeNull();
    expect(sessionAgentHandle({ agent_handle: 3 })).toBeNull();
    expect(sessionAgentHandle(null)).toBeNull();
  });

  test('stringOrNull (via normalizeRuntimeSessionSnapshot) trims; blank or non-strings are null', () => {
    expect(normalizeRuntimeSessionSnapshot({ id: ' s1 ', title: ' T ', parent_id: '   ', project_id: 4 })).toMatchObject({
      id: 's1',
      title: 'T',
      parent_id: null,
      project_id: null,
    });
    expect(normalizeRuntimeSessionSnapshot({ id: '   ' })).toBeNull();
  });
});
