import { describe, expect, test } from 'bun:test';
import {
  SECRET_VALUE_PLACEHOLDER,
  isCopyableHttp,
  renderHttp,
} from '@kortix/white-label-shared/call-snippets';
import {
  AUTHORIZATION_HEADER,
  CALL_SNIPPET_IDS,
  type SnippetContext,
  callSnippet,
  callSnippets,
} from '../../src/lib/call-snippets';
import { NO_OVERRIDES, buildSessionCreateInput } from '../../src/lib/session-overrides';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const REMOVED_ATTRIBUTION_PATTERN = new RegExp(
  `${['end', 'user', 'ref'].join('_')}|${['origin', 'ref'].join('_')}`,
);

/** Everything one snippet renders, as one string — the shape a screenshot has. */
function rendered(id: (typeof CALL_SNIPPET_IDS)[number], ctx: SnippetContext = {}): string {
  const snippet = callSnippet(id, ctx);
  return [
    snippet.title,
    snippet.summary,
    snippet.sdk,
    renderHttp(snippet.http, AUTHORIZATION_HEADER),
    ...snippet.notes,
  ].join('\n');
}

/** Everything EVERY snippet renders, for the invariants that must hold globally. */
function renderedAll(ctx: SnippetContext = {}): string {
  return CALL_SNIPPET_IDS.map((id) => rendered(id, ctx)).join('\n');
}

describe('call snippets never render credentials', () => {
  /**
   * The exact hazard: `GET /projects/{id}/secrets` returns rows, a screen holds
   * one, and a careless snippet builder spreads it into a request body. The
   * builder has to PICK the identifier and the env KEY — which is why
   * `SnippetContext['secret']` has no `value` field at all.
   */
  const fromSecretsApi = {
    identifier: 'STRIPE_KEY',
    name: 'STRIPE_SECRET_KEY',
    value: 'sk-live-DO-NOT-RENDER-4f9c',
    configured: true,
    effective_source: 'shared',
    mine: { active: true, value: 'sk-live-personal-DO-NOT-RENDER-11a2' },
  };

  test('a secret row from the API cannot leak into any snippet', () => {
    // Passed the way a careless caller would pass it — the whole API row.
    const text = renderedAll({
      projectId: PROJECT_ID,
      secret: fromSecretsApi as SnippetContext['secret'],
    });
    expect(text).not.toContain(fromSecretsApi.value);
    expect(text).not.toContain(fromSecretsApi.mine.value);
    // The addressable parts are exactly what SHOULD show up.
    expect(text).toContain('STRIPE_KEY');
    expect(text).toContain('STRIPE_SECRET_KEY');
  });

  test('a secret value is always the placeholder', () => {
    const snippet = callSnippet('secret.upsert', {
      secret: fromSecretsApi as SnippetContext['secret'],
    });
    expect(snippet.sdk).toContain(SECRET_VALUE_PLACEHOLDER);
    expect(renderHttp(snippet.http, AUTHORIZATION_HEADER)).toContain(SECRET_VALUE_PLACEHOLDER);
  });

  test('the bearer is only ever the placeholder', () => {
    const text = renderedAll({ projectId: PROJECT_ID });
    // Any `Bearer` that is not the placeholder is a real token in a snippet.
    expect(text.match(/Bearer (?!\$KORTIX_API_KEY)\S+/)).toBeNull();
  });
});

describe('attribution data is absent', () => {
  test('no snippet contains an upstream customer attribution field', () => {
    expect(renderedAll({ projectId: PROJECT_ID })).not.toMatch(REMOVED_ATTRIBUTION_PATTERN);
  });

  test('no snippet claims the server injects product data', () => {
    expect(callSnippets().filter((snippet) => snippet.serverInjected.length > 0)).toEqual([]);
  });
});

describe('the create snippet is the request the dialog would send', () => {
  test('an untouched dialog shows the bare create', () => {
    const snippet = callSnippet('session.create', { overrides: NO_OVERRIDES });
    expect(snippet.sdk).not.toContain('agent_name');
    expect(snippet.sdk).not.toContain('secrets');
    expect(snippet.sdk).not.toContain('connector_bindings');
  });

  test('the chosen overrides are the ones rendered', () => {
    const snippet = callSnippet('session.create', {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      overrides: {
        agent: 'support',
        secrets: ['STRIPE_KEY'],
        bindings: { slack: 'connection_9' },
        runtimeContext: null,
      },
    });
    expect(snippet.sdk).toContain('"agent_name": "support"');
    expect(snippet.sdk).toContain('"secrets"');
    expect(snippet.sdk).toContain('"connection_id": "connection_9"');
    // Binding one alias must not read as unplugging the others.
    expect(snippet.sdk).toContain('"inherit_unbound": true');
  });

  test('the session id is a generated variable, not something to type', () => {
    const snippet = callSnippet('session.create', { sessionId: SESSION_ID });
    expect(snippet.sdk).toContain('generateSessionId()');
    expect(snippet.sdk).toContain('"session_id": sessionId');
    // The wire form still shows the concrete value.
    expect(renderHttp(snippet.http, AUTHORIZATION_HEADER)).toContain(
      `"session_id": "${SESSION_ID}"`,
    );
  });

  test('the path is the project the screen is on', () => {
    const snippet = callSnippet('session.create', { projectId: PROJECT_ID });
    expect(renderHttp(snippet.http, AUTHORIZATION_HEADER)).toContain(
      `POST /v1/projects/${PROJECT_ID}/sessions`,
    );
  });
});

describe('the other calls', () => {
  test('a prompt has no REST path to copy — the SDK owns the runtime transport', () => {
    const snippet = callSnippet('session.prompt', { agent: 'support' });
    expect(isCopyableHttp(snippet.http)).toBe(false);
    expect(snippet.sdk).toContain(".send('Refund order 4182', { agent: 'support' })");
    // Printing a runtime path here is exactly what scripts/sdk-boundary.mjs
    // forbids client code from constructing.
    expect(rendered('session.prompt')).not.toContain('/v1/p/');
  });

  test('the model change shows both hops and neither spells the runtime field', () => {
    // The model text is the module's own placeholder — no caller names a model,
    // so `SnippetContext` has no `model` field to pass one through.
    const snippet = callSnippet('session.model', {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
    });
    expect(snippet.sdk).toContain("changeModel('anthropic/claude-sonnet-4-5')");
    expect(snippet.sdk).toContain('/api/session-model');
    expect(renderHttp(snippet.http, AUTHORIZATION_HEADER)).toContain(
      `PUT /v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/model`,
    );
    expect(rendered('session.model').toLowerCase()).not.toContain('opencode');
  });

  test('session costs are read for the current project', () => {
    expect(
      renderHttp(
        callSnippet('session.costs', { projectId: PROJECT_ID }).http,
        AUTHORIZATION_HEADER,
      ),
    ).toContain(`GET /v1/usage/session-costs?project_id=${PROJECT_ID}`);
  });

  test('a secret is addressed by identifier', () => {
    const snippet = callSnippet('secret.upsert', {
      projectId: PROJECT_ID,
      secret: { identifier: 'GMAPS-backup', name: 'GOOGLE_MAPS_API_KEY' },
    });
    expect(snippet.sdk).toContain('"identifier": "GMAPS-backup"');
    expect(snippet.sdk).toContain('"name": "GOOGLE_MAPS_API_KEY"');
  });
});

describe('every snippet is complete', () => {
  test('each one has both forms and at least one note', () => {
    for (const snippet of callSnippets()) {
      expect(snippet.sdk.trim().length).toBeGreaterThan(0);
      expect(renderHttp(snippet.http, AUTHORIZATION_HEADER).trim().length).toBeGreaterThan(0);
      expect(snippet.notes.length).toBeGreaterThan(0);
      // A blank placeholder would render as `/v1/projects//sessions`.
      expect(renderHttp(snippet.http, AUTHORIZATION_HEADER)).not.toContain('//sessions');
    }
  });

  test('ids are unique and every id builds', () => {
    const ids = callSnippets().map((s) => s.id);
    expect(new Set(ids).size).toBe(CALL_SNIPPET_IDS.length);
    expect(ids).toEqual([...CALL_SNIPPET_IDS]);
  });
});

describe('the create snippet cannot drift from what the app sends', () => {
  test('a bound connection prints its connection id', () => {
    const snippet = callSnippet('session.create', {
      projectId: 'p1',
      overrides: {
        ...NO_OVERRIDES,
        bindings: { slack: 'auth_9' },
        runtimeContext: null,
      },
    });
    const printed = `${snippet.sdk}${renderHttp(snippet.http, AUTHORIZATION_HEADER)}`;
    expect(printed).toContain('"connection_id": "auth_9"');
  });

  test('the same builder the submit path uses produces the body', () => {
    // Guards the mechanism rather than one output: if someone hand-rolls the
    // body here again, an override added to buildSessionCreateInput stops
    // appearing and this goes red.
    const overrides = {
      ...NO_OVERRIDES,
      agent: 'reviewer',
      secrets: ['GMAIL'],
    };
    const snippet = callSnippet('session.create', {
      projectId: 'p1',
      overrides,
    });
    const expected = buildSessionCreateInput(overrides, { sessionId: 'SID' });
    for (const key of Object.keys(expected)) {
      if (key === 'session_id') continue;
      expect(`${snippet.sdk}${renderHttp(snippet.http, AUTHORIZATION_HEADER)}`).toContain(key);
    }
  });
});
