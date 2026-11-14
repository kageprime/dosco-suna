/** KRTX-4800: the agent-access gate's own refusal constructor marks every
 * denial it throws, so the global error handler rate-limits the LINE. The
 * typed 403 body still ships on every call — that contract is pinned at the
 * error handler in shared/dead-credential-log.test.ts.
 *
 * The gate's only database reads on the no-access path are the object-grant
 * memo and the accessible fold (iam/authorize), mocked to an empty project:
 * no grant anywhere, so the deny-by-default rule refuses a member. Everything
 * else on the path (actor shape, the mirror default, the feature flag) is
 * pure. middleware/auth.test.ts pins the same split for `deadCredential401`.
 */
import { describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

// Override ONLY the gate's two database reads (grant memo + accessible fold);
// every other export stays real, because other modules of the gate's import
// graph link this module and need its full surface.
const realAuthorize = await import('../iam/authorize');
mock.module('../iam/authorize', () => ({
  ...realAuthorize,
  filterAccessibleObjects: async () => [],
  loadObjectGrants: async () => new Map<string, never>(),
}));

const { resolveAndAuthorizeAgentAs } = await import('../projects/lib/agent-access');
const { actorForUser } = await import('../iam/actor');
const { isAgentAccessDenial } = await import('../shared/dead-credential-log');

const humanActor = actorForUser('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');

describe('agent-access denials are marked at the gate', () => {
  test('a member with no agent grants gets the marked no_agent_access 403', async () => {
    let thrown: unknown;
    try {
      await resolveAndAuthorizeAgentAs(
        humanActor,
        null,
        { row: { metadata: null }, userId: '00000000-0000-4000-8000-000000000001' },
        '00000000-0000-4000-8000-000000000003',
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HTTPException);
    const denial = thrown as HTTPException;
    expect(denial.status).toBe(403);
    expect(isAgentAccessDenial(denial)).toBe(true);
    if (!denial.res) throw new Error('the marked denial ships no response');
    const body = JSON.parse(await denial.res.text());
    expect(body.code).toBe('no_agent_access');
    expect(body.accessible_agents).toEqual([]);
    expect(body.message).toContain('Ask a manager to grant you one');
  });
});
