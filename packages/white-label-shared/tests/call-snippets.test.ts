import { describe, expect, test } from 'bun:test';
import {
  type CallSnippet,
  approvalResolve,
  isCopyableHttp,
  renderHttp,
  sessionDelete,
} from '../src/call-snippets';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const AUTHORIZATION = 'Authorization: Bearer $TEST_TOKEN';
const REMOVED_ATTRIBUTION_PATTERN = new RegExp(
  `${['end', 'user', 'ref'].join('_')}|${['origin', 'ref'].join('_')}`,
);

/** The two calls both apps document, with a stand-in for each app's own note. */
function shared(
  ctx: { projectId?: string; sessionId?: string; executionId?: string } = {},
): CallSnippet[] {
  return [sessionDelete(ctx, 'Ownership note.'), approvalResolve(ctx, 'Inbox note.')];
}

/** Everything one snippet renders, as one string — the shape a screenshot has. */
function rendered(snippet: CallSnippet): string {
  return [
    snippet.title,
    snippet.summary,
    snippet.sdk,
    renderHttp(snippet.http, AUTHORIZATION),
    ...snippet.notes,
  ].join('\n');
}

describe('call snippets never render credentials', () => {
  test('the bearer is only ever the placeholder the app passes', () => {
    const text = shared({ projectId: PROJECT_ID }).map(rendered).join('\n');
    // Any `Bearer` that is not the placeholder is a real token in a snippet.
    expect(text.match(/Bearer (?!\$TEST_TOKEN)\S+/)).toBeNull();
  });

  test('the authorization line sits right under the request line, and only on REST', () => {
    for (const snippet of shared({ projectId: PROJECT_ID })) {
      expect(isCopyableHttp(snippet.http)).toBe(true);
      expect(renderHttp(snippet.http, AUTHORIZATION).split('\n')[1]).toBe(AUTHORIZATION);
    }
    expect(
      renderHttp({ kind: 'runtime', summary: 'Through the session proxy.' }, AUTHORIZATION),
    ).toBe('Through the session proxy.');
  });
});

describe('attribution data is absent', () => {
  test('no snippet contains an upstream customer attribution field', () => {
    const text = shared({ projectId: PROJECT_ID }).map(rendered).join('\n');
    expect(text).not.toMatch(REMOVED_ATTRIBUTION_PATTERN);
  });

  test('no snippet claims the server injects product data', () => {
    expect(shared().filter((snippet) => snippet.serverInjected.length > 0)).toEqual([]);
  });
});

describe('the other calls', () => {
  test('an approval resolves by execution id, and carries no widening scope', () => {
    const snippet = approvalResolve(
      { projectId: PROJECT_ID, executionId: 'exec_42' },
      'Inbox note.',
    );
    const rendered = renderHttp(snippet.http, AUTHORIZATION);
    expect(rendered).toContain(`POST /v1/projects/${PROJECT_ID}/approvals/exec_42`);
    expect(rendered).toContain('"decision": "approve"');
    // The documented call must not teach a scope that no longer exists — the
    // decision covers exactly the call that asked for it.
    expect(rendered).not.toContain('scope');
  });

  test('a session delete names the session the screen is on', () => {
    const snippet = sessionDelete(
      { projectId: PROJECT_ID, sessionId: SESSION_ID },
      'Ownership note.',
    );
    expect(renderHttp(snippet.http, AUTHORIZATION)).toBe(
      `DELETE /v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}\n${AUTHORIZATION}`,
    );
    expect(snippet.notes).toContain('Ownership note.');
  });
});

describe('every snippet is complete', () => {
  test('each one has both forms and at least one note', () => {
    for (const snippet of shared()) {
      expect(snippet.sdk.trim().length).toBeGreaterThan(0);
      expect(renderHttp(snippet.http, AUTHORIZATION).trim().length).toBeGreaterThan(0);
      expect(snippet.notes.length).toBeGreaterThan(0);
      // A blank placeholder would render as `/v1/projects//sessions`.
      expect(renderHttp(snippet.http, AUTHORIZATION)).not.toContain('//sessions');
    }
  });
});
