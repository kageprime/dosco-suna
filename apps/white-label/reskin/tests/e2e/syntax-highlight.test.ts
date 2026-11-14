/**
 * The snippet highlighter, held to the one promise that outranks its colours:
 * the spans it produces must still spell the exact snippet.
 *
 * A wrapper author copies these blocks into an editor and runs them. Colouring
 * that drops a brace, eats a space or reorders a line would turn a teaching
 * surface into a broken call — so the identity check runs over every snippet
 * the app can actually produce, not over a handful of hand-written samples.
 * The highlighter's own invariants live in `packages/white-label-shared`.
 */

import { describe, expect, test } from 'bun:test';
import { isCopyableHttp, renderHttp } from '@kortix/white-label-shared/call-snippets';
import {
  AUTHORIZATION_HEADER,
  CALL_SNIPPET_IDS,
  type SnippetContext,
  callSnippet,
} from '../../src/lib/call-snippets';
import { NO_OVERRIDES } from '../../src/lib/session-overrides';
import { type SnippetLanguage, type TokenKind, highlight } from '@kortix/white-label-shared/syntax-highlight';

const LANGUAGES: SnippetLanguage[] = ['ts', 'json', 'http'];

const KINDS: TokenKind[] = [
  'plain',
  'punctuation',
  'comment',
  'keyword',
  'string',
  'number',
  'property',
  'method',
  'path',
];

/** The contexts the six mount points actually pass — an empty one (the create
 *  dialog, before any session exists) through a fully populated one. */
const CONTEXTS: SnippetContext[] = [
  {},
  { projectId: 'p1', sessionId: 's1' },
  {
    projectId: '11111111-1111-4111-8111-111111111111',
    sessionId: '00000000-0000-4000-8000-000000000001',
    executionId: 'exec_42',
    agent: 'support',
    overrides: {
      ...NO_OVERRIDES,
      agent: 'support',
      secrets: ['STRIPE_KEY'],
      bindings: { slack: 'connection_9' },
      runtimeContext: null,
    },
    secret: { identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' },
  },
];

/** Every code block the panel can render, with the language it renders it as. */
function everyBlock(): Array<{ code: string; language: SnippetLanguage }> {
  const blocks: Array<{ code: string; language: SnippetLanguage }> = [];
  for (const context of CONTEXTS) {
    for (const id of CALL_SNIPPET_IDS) {
      const snippet = callSnippet(id, context);
      blocks.push({ code: snippet.sdk, language: 'ts' });
      blocks.push({ code: renderHttp(snippet.http, AUTHORIZATION_HEADER), language: 'http' });
      if (snippet.http.kind === 'rest' && snippet.http.body !== undefined) {
        blocks.push({
          code: JSON.stringify(snippet.http.body, null, 2),
          language: 'json',
        });
      }
    }
  }
  return blocks;
}

function joined(code: string, language: SnippetLanguage): string {
  return highlight(code, language)
    .map((token) => token.text)
    .join('');
}

describe('highlighting cannot alter the text', () => {
  test('every block the app can render survives byte for byte', () => {
    const blocks = everyBlock();
    // Guards the guard: an empty corpus would make this suite vacuously green.
    expect(blocks.length).toBeGreaterThan(CALL_SNIPPET_IDS.length);
    for (const { code, language } of blocks) {
      expect(joined(code, language)).toBe(code);
    }
  });

  test('every block survives being read as any of the three languages', () => {
    // The panel picks the language, so a mismatch is a bug — but a mismatched
    // language must still not corrupt the text it renders.
    for (const { code } of everyBlock()) {
      for (const language of LANGUAGES) {
        expect(joined(code, language)).toBe(code);
      }
    }
  });

  test('the placeholder bearer line comes through untouched', () => {
    // The panel's security claim is that the only bearer ever rendered is the
    // placeholder. Highlighting must not be the thing that splits it up.
    for (const id of CALL_SNIPPET_IDS) {
      const snippet = callSnippet(id, { projectId: 'p1' });
      if (!isCopyableHttp(snippet.http)) continue;
      expect(joined(renderHttp(snippet.http, AUTHORIZATION_HEADER), 'http')).toContain(
        AUTHORIZATION_HEADER,
      );
    }
  });

  test('the connector authorization field is still legible in the wire form', () => {
    const snippet = callSnippet('session.create', {
      projectId: 'p1',
      overrides: {
        ...NO_OVERRIDES,
        bindings: { slack: 'auth_9' },
      },
    });
    expect(joined(renderHttp(snippet.http, AUTHORIZATION_HEADER), 'http')).toContain('"connection_id": "auth_9"');
  });

  test('no token is empty and every kind is one the panel can colour', () => {
    for (const { code, language } of everyBlock()) {
      for (const token of highlight(code, language)) {
        expect(token.text.length).toBeGreaterThan(0);
        expect(KINDS).toContain(token.kind);
      }
    }
  });
});

describe('the three languages are told apart', () => {
  test('the wire form colours the method, the path and the header names', () => {
    const snippet = callSnippet('session.create', { projectId: 'p1' });
    const tokens = highlight(renderHttp(snippet.http, AUTHORIZATION_HEADER), 'http');
    expect(tokens[0]).toEqual({ text: 'POST', kind: 'method' });
    expect(tokens.find((token) => token.kind === 'path')?.text).toBe('/v1/projects/p1/sessions');
    expect(
      tokens.some((token) => token.kind === 'property' && token.text === '"session_id"'),
    ).toBe(
      true,
    );
  });

  test('a GET with no body is all head', () => {
    const tokens = highlight(renderHttp(callSnippet('session.costs').http, AUTHORIZATION_HEADER), 'http');
    expect(tokens[0]).toEqual({ text: 'GET', kind: 'method' });
    expect(tokens.find((token) => token.kind === 'path')?.text).toBe(
      '/v1/usage/session-costs?project_id=%7BprojectId%7D',
    );
  });
});
