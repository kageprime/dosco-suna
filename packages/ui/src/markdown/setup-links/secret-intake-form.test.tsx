import { afterEach, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { RadioGroup } from '../../primitives/radio-group';
import { SecretIntakeForm } from './secret-intake-form';

const originalFetch = globalThis.fetch;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
  globalThis.fetch = originalFetch;
});

test.each(['connector', 'runtime', undefined] as const)('shows %s delivery before accepting a value', async (scope) => {
  globalThis.fetch = Object.assign(async () => Response.json({
    project_name: 'Synthetic project', fields: [{ name: 'DEMO_KEY', label: null, description: null }],
    expires_at: '2099-01-01T00:00:00Z', scope,
  }), { preconnect: originalFetch.preconnect });
  await act(async () => { renderer = create(<SecretIntakeForm token="synthetic-token" compact />); });
  const html = JSON.stringify(renderer?.toJSON());
  expect(html).toContain(scope === 'runtime' ? 'Delivery: runtime' : scope === 'connector' ? 'Delivery: connector' : 'Delivery scope is unavailable');
  expect(html).toContain('DEMO_KEY');
  if (scope === 'runtime') expect(html).toContain('Agent code can read it');
  if (scope === 'connector') expect(html).toContain('never enters the sandbox environment');
});

test('the full form points the encryption promise at the disclosed delivery scope', async () => {
  globalThis.fetch = Object.assign(async () => Response.json({
    project_name: 'Synthetic project', fields: [{ name: 'DEMO_KEY', label: null, description: null }],
    expires_at: '2099-01-01T00:00:00Z', scope: 'connector',
  }), { preconnect: originalFetch.preconnect });
  await act(async () => { renderer = create(<SecretIntakeForm token="synthetic-token" />); });
  const html = JSON.stringify(renderer?.toJSON());
  expect(html).toContain('Encrypted at rest. Delivery follows the scope shown above.');
  expect(html).toContain('Delivery: connector');
});

test('a website login link shows its sites, starts private, and submits the login', async () => {
  const posts: unknown[] = [];
  globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, saved: ['CRM_LOGIN'] });
    }
    return Response.json({
      project_name: 'Synthetic project', scope: 'browser', requester: { label: 'Ada' },
      fields: [{ name: 'CRM_LOGIN', label: null, description: null, sites: ['app.example.test'] }],
      expires_at: '2099-01-01T00:00:00Z',
    });
  }, { preconnect: originalFetch.preconnect });
  await act(async () => { renderer = create(<SecretIntakeForm token="synthetic-token" compact />); });
  const root = renderer!.root;
  const html = JSON.stringify(renderer?.toJSON());
  expect(html).toContain('A website login for app.example.test.');
  expect(html).toContain('The agent sees only its name.');

  const username = root.findByProps({ id: 'login-CRM_LOGIN-username' });
  const password = root.findByProps({ id: 'login-CRM_LOGIN-password' });
  expect(password.props.type).toBe('password');
  // A login acts as one person: "Only Ada" is preselected.
  expect(root.findByType(RadioGroup).props.value).toBe('requester');

  // Nothing is sent until both parts are filled.
  const save = root.findAll((node) => node.type === 'button' && typeof node.props.onClick === 'function').at(-1)!;
  await act(async () => { save.props.onClick(); });
  expect(posts).toEqual([]);
  expect(JSON.stringify(renderer?.toJSON())).toContain('Enter a username and a password.');

  await act(async () => { username.props.onChange({ target: { value: '  ada@example.test ' } }); });
  await act(async () => { password.props.onChange({ target: { value: ' pw with spaces ' } }); });
  await act(async () => { save.props.onClick(); });
  expect(posts).toEqual([
    { logins: { CRM_LOGIN: { username: 'ada@example.test', password: ' pw with spaces ' } }, only_requester: true },
  ]);
  expect(JSON.stringify(renderer?.toJSON())).toContain('Login saved');
});
