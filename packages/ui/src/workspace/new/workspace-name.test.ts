// packages/ui/src/workspace/new/workspace-name.test.ts
import { describe, expect, test } from 'bun:test';

import {
  WORKSPACE_NAME_MAX_LENGTH,
  readNameParam,
  withNameParam,
  suggestWorkspaceName,
  validateWorkspaceName,
  workspaceNameMessage,
} from './workspace-name';

describe('validateWorkspaceName', () => {
  test('accepts letters, numbers, spaces, hyphens, underscores and dots', () => {
    expect(validateWorkspaceName('my-agi_company.v2 3')).toEqual({
      ok: true,
      name: 'my-agi_company.v2 3',
    });
  });

  test('trims surrounding whitespace before validating', () => {
    expect(validateWorkspaceName('  suna-web  ')).toEqual({ ok: true, name: 'suna-web' });
  });

  test('rejects an empty or whitespace-only name', () => {
    expect(validateWorkspaceName('')).toEqual({ ok: false, error: 'Name is required' });
    expect(validateWorkspaceName('   ')).toEqual({ ok: false, error: 'Name is required' });
  });

  test('rejects characters the API rejects', () => {
    expect(validateWorkspaceName('my/agi')).toEqual({
      ok: false,
      error: 'Use only letters, numbers, spaces, hyphens, underscores or dots',
    });
    expect(validateWorkspaceName('café')).toEqual({
      ok: false,
      error: 'Use only letters, numbers, spaces, hyphens, underscores or dots',
    });
  });

  test('rejects a name longer than the API ceiling', () => {
    const tooLong = 'a'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1);
    expect(validateWorkspaceName(tooLong)).toEqual({
      ok: false,
      error: `Name must be ${WORKSPACE_NAME_MAX_LENGTH} characters or fewer`,
    });
  });

  test('accepts a name exactly at the ceiling', () => {
    const exact = 'a'.repeat(WORKSPACE_NAME_MAX_LENGTH);
    expect(validateWorkspaceName(exact)).toEqual({ ok: true, name: exact });
  });
});

describe('workspaceNameMessage', () => {
  const t = (key: 'validation.nameRequired' | 'validation.nameCharacters' | 'validation.nameTooLong', vars?: { max: number }) =>
    key === 'validation.nameTooLong' ? `tooLong:${vars?.max}` : key;

  test('a valid name renders no message', () => {
    expect(workspaceNameMessage(validateWorkspaceName('Amber Atlas'), false, t)).toBeNull();
    expect(workspaceNameMessage(validateWorkspaceName('Amber Atlas'), true, t)).toBeNull();
  });

  test('an illegal character reports itself live, before the field is left', () => {
    // KRTX-4627: the error disables submit the moment it exists, so the
    // message must be there when the button goes dark.
    expect(workspaceNameMessage(validateWorkspaceName('bad/name!'), false, t)).toBe(
      'validation.nameCharacters',
    );
  });

  test('a too-long name reports itself live with the limit', () => {
    expect(
      workspaceNameMessage(validateWorkspaceName('a'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1)), false, t),
    ).toBe(`tooLong:${WORKSPACE_NAME_MAX_LENGTH}`);
  });

  test('"required" waits for the field to be left once', () => {
    expect(workspaceNameMessage(validateWorkspaceName(''), false, t)).toBeNull();
    expect(workspaceNameMessage(validateWorkspaceName('   '), true, t)).toBe('validation.nameRequired');
  });
});

describe('suggestWorkspaceName', () => {
  test('every suggestion is a valid name, so /new never opens on "Name is required"', () => {
    for (let i = 0; i < 16; i += 1) {
      const steps = [i / 16, ((i * 7) % 16) / 16];
      let call = 0;
      const name = suggestWorkspaceName(() => steps[call++ % 2]!);
      expect(validateWorkspaceName(name)).toEqual({ ok: true, name });
    }
  });

  test('is two capitalised words', () => {
    expect(suggestWorkspaceName(() => 0)).toBe('Amber Atlas');
    expect(suggestWorkspaceName(() => 0.999)).toBe('Vivid Willow');
  });
});

describe('the More options name handoff', () => {
  test('carries the shown name and reads the same name back', () => {
    const href = withNameParam('/workspaces/new', '  Bright Comet ');
    expect(href).toBe('/workspaces/new?name=Bright+Comet');
    expect(readNameParam(new URL(href, 'http://x').searchParams)).toBe('Bright Comet');
  });

  test('keeps the params already on the href', () => {
    expect(withNameParam('/workspaces/new?connect=computer', 'Acme')).toBe(
      '/workspaces/new?connect=computer&name=Acme',
    );
  });

  test('an empty name leaves the href alone', () => {
    expect(withNameParam('/workspaces/new', '   ')).toBe('/workspaces/new');
  });

  test('an absent or invalid name reads as null, so the page suggests its own', () => {
    expect(readNameParam(new URLSearchParams(''))).toBeNull();
    expect(readNameParam(new URLSearchParams('name=%3Cscript%3E'))).toBeNull();
    expect(readNameParam(new URLSearchParams(`name=${'a'.repeat(WORKSPACE_NAME_MAX_LENGTH + 1)}`))).toBeNull();
  });
});
