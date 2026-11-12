import { describe, expect, test } from 'bun:test';
import { runTool, type ToolResult } from './index';

// list_projects reaches the API through ctx.dispatch, the same in-process
// dispatch the real route table gets. A canned dispatch answers the one read
// the tool makes (GET /v1/workspaces): every workspace the caller may open, or
// the one a workspace-bound token is bound to.
function api(bodies: Record<string, unknown>, status = 200) {
  return async (req: Request) => {
    const body = bodies[new URL(req.url).pathname];
    return new Response(JSON.stringify(body ?? { error: 'unrouted' }), {
      status: body === undefined ? 500 : status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function ctx(dispatch: (req: Request) => Promise<Response>) {
  return {
    authorization: 'Bearer test',
    origin: 'http://localhost:8008',
    headers: new Headers(),
    dispatch,
    deadline: Date.now() + 5_000,
  };
}

/** The text a client JSON.parses: content[0].text must be JSON in every account state. */
function dataText(r: ToolResult): string {
  const first = r.content[0]!;
  if (first.type !== 'text') throw new Error(`expected a text part, got ${first.type}`);
  return first.text;
}

const workspace = {
  project_id: '22222222-2222-2222-2222-222222222222',
  workspace_id: '22222222-2222-2222-2222-222222222222',
  account_id: '11111111-1111-1111-1111-111111111111',
  name: 'dogfood-test',
  effective_project_role: 'owner',
};

describe('list_projects', () => {
  test('no workspaces answers a JSON array, not prose', async () => {
    const r = await runTool(ctx(api({ '/v1/workspaces': [] })), 'list_projects', {});
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(dataText(r))).toEqual([]);
  });

  test('a workspace keeps the project row shape clients already read', async () => {
    const r = await runTool(ctx(api({ '/v1/workspaces': [workspace] })), 'list_projects', {});
    expect(JSON.parse(dataText(r))).toEqual([
      {
        project_id: '22222222-2222-2222-2222-222222222222',
        name: 'dogfood-test',
        account: 'dogfood-test',
        account_id: '11111111-1111-1111-1111-111111111111',
        repository: null,
        default_branch: null,
        role: 'owner',
      },
    ]);
  });

  test('a refused read is an isError result with the API status', async () => {
    const r = await runTool(ctx(api({ '/v1/workspaces': { error: 'nope' } }, 403)), 'list_projects', {});
    expect(r.isError).toBe(true);
  });
});
