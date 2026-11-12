/**
 * KRTX-1719: an account key or ChatGPT login Dosco can no longer decrypt
 * (`status: 'undecryptable'`) is skipped by the gateway without a word. The
 * provider panel used to list it as a healthy row. It now shows the
 * Undecryptable badge, and the remedy to whoever may apply it: Re-enter key
 * (the rotate dialog, `PUT …/value`) for a key, Reconnect for a login.
 *
 * A new key is shared with everyone in the workspace by default. A member who
 * may not share (no `project.secret.write`) gets "Only you", the one choice
 * the API accepts from them.
 *
 * Runs the real panel against `happy-dom`; the list hook, the member list, the
 * auth context, the permission probe and the create and rotate calls are stubs.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.localStorage = win.localStorage;
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && !(key in globals)) globals[key] = Reflect.get(win, key);
}
// The dialog's focus and dismiss layers create events by bare global name,
// and happy-dom dispatches only its own.
for (const key of ['Event', 'CustomEvent', 'FocusEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
  globals[key] = Reflect.get(win, key);
}

// After the globals: react-dom decides at load whether the DOM has `input` events.
const { createRoot } = await import('react-dom/client');

const ME = 'user-1';
type Row = {
  secret_id: string; label: string; status?: 'ok' | 'undecryptable'; created_by?: string;
  verification?: { status: 'verified' | 'invalid' | 'unknown'; message: string; checked_at: string } | null;
};
let rows: Row[] = [];
const rotations: Array<[string, string, string]> = [];
const creates: Array<[string, Record<string, unknown>]> = [];
/** The `project.secret.write` probe's answer. */
let mayShare = true;

function resource(row: Row) {
  return {
    provider_id: 'anthropic',
    name: 'ANTHROPIC_API_KEY',
    access_mode: 'project',
    project_id: 'p1',
    active: true,
    created_by: ME,
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z',
    granted_user_ids: [],
    can_use: true,
    cooldown_until: null,
    needs_reauth_at: null,
    ...row,
  };
}

const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  listAccountMembers: async () => [],
  createAccountSecretResource: async (accountId: string, body: Record<string, unknown>) => {
    creates.push([accountId, body]);
    return resource({ secret_id: 'new', label: String(body.label), status: 'ok' });
  },
  rotateAccountSecretResource: async (accountId: string, secretId: string, value: string) => {
    rotations.push([accountId, secretId, value]);
    return resource({ secret_id: secretId, label: 'Primary', status: 'ok' });
  },
}));
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...sdkReact,
  refreshProjectProviderState: () => undefined,
  useAccountSecretResources: () => ({
    data: { secrets: rows.map(resource) },
    isSuccess: true,
    isLoading: false,
    isError: false,
    isFetching: false,
    dataUpdatedAt: Date.parse('2026-10-13T00:00:00.000Z'),
    refetch: async () => ({ data: { secrets: rows.map(resource) } }),
  }),
}));
const realUiProvider = { ...(await import('../../../providers/ui-provider')) };
mock.module('../../../providers/ui-provider', () => ({ ...realUiProvider, useUiViewer: () => ({ id: ME }) }));
const projectCan = await import('../../../internal/lib/use-project-can');
mock.module('../../../internal/lib/use-project-can', () => ({ ...projectCan, useProjectCan: () => ({ allowed: mayShare }) }));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { IntlTestProvider: NextIntlClientProvider } = await import('../../../test-utils/intl');
const messages = (await import('../../../../../../apps/web/translations/en.json')).default;
const { AccountSecretResourcesPanel } = await import('./account-secret-resources-panel');

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(canWrite = true, oauth = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} onError={() => {}}>
          <AccountSecretResourcesPanel
            accountId="account-1"
            projectId="p1"
            providerId="anthropic"
            providerName="Anthropic"
            envVar="ANTHROPIC_API_KEY"
            canWrite={canWrite}
            {...(oauth ? { oauth: { projectId: 'p1', onConnected: () => undefined } } : {})}
          />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  rows = [];
  rotations.length = 0;
  creates.length = 0;
  mayShare = true;
  document.body.innerHTML = '';
});

const settle = (ms = 0) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const listItems = () => [...document.querySelectorAll('li')];
const buttonsIn = (element: Element) => [...element.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
const buttonNamed = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const radio = (choice: 'private' | 'project' | 'members') => document.querySelector<HTMLButtonElement>(`#create-anthropic-${choice}`)!;
async function typeInto(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
  });
}
/** Opens Add key, names the key and enters a value; leaves "Who can use it?" as the dialog set it. */
async function fillNewKey(label: string, value: string) {
  mount();
  await act(async () => buttonNamed('Add key')!.click());
  await settle();
  await typeInto(document.querySelector<HTMLInputElement>('#provider-key-label-anthropic')!, label);
  await typeInto(document.querySelector<HTMLInputElement>('#provider-key-value-anthropic')!, value);
  await settle();
}

describe('who can use a new key', () => {
  test('a member who may share sees "Everyone in this workspace" selected and saves a project-wide key', async () => {
    await fillNewKey('Team key', 'synthetic-team-key');
    expect(radio('project').getAttribute('data-state')).toBe('checked');
    expect(radio('private').getAttribute('data-state')).toBe('unchecked');
    expect(document.body.textContent).not.toContain('Sharing with others requires permission');

    await act(async () => buttonNamed('Save key')!.click());
    await settle(20);
    expect(creates).toEqual([['account-1', expect.objectContaining({
      project_id: 'p1', provider_id: 'anthropic', label: 'Team key', value: 'synthetic-team-key',
      access_mode: 'project', user_ids: [],
    })]]);
  });

  test('a member who may not share sees "Only you" selected, cannot pick a shared choice, and saves a key only they can use', async () => {
    mayShare = false;
    await fillNewKey('My key', 'synthetic-own-key');
    expect(radio('private').getAttribute('data-state')).toBe('checked');
    expect(radio('project').getAttribute('data-state')).toBe('unchecked');
    expect(radio('project').disabled).toBe(true);
    expect(radio('members').disabled).toBe(true);
    expect(document.body.textContent).toContain('Sharing with others requires permission to manage workspace secrets.');

    await act(async () => buttonNamed('Save key')!.click());
    await settle(20);
    // `members` with no one listed: the API grants the creator alone.
    expect(creates).toEqual([['account-1', expect.objectContaining({ label: 'My key', access_mode: 'members', user_ids: [] })]]);
  });
});

describe('an account key Dosco cannot decrypt', () => {
  test('shows the badge and Re-enter key; a decryptable key shows neither', () => {
    rows = [
      { secret_id: 'lost', label: 'Primary', status: 'undecryptable' },
      { secret_id: 'fine', label: 'Backup', status: 'ok' },
    ];
    mount();
    const [lost, fine] = listItems();
    expect(lost?.textContent).toContain('Undecryptable');
    expect(buttonsIn(lost!)).toContain('Re-enter key');
    expect(fine?.textContent).not.toContain('Undecryptable');
    expect(buttonsIn(fine!)).not.toContain('Re-enter key');
  });

  test('Re-enter key opens the rotate dialog and saves the new value to that key', async () => {
    rows = [{ secret_id: 'lost', label: 'Primary', status: 'undecryptable' }];
    mount();
    const reenter = [...listItems()[0]!.querySelectorAll('button')].find((b) => b.textContent === 'Re-enter key');
    await act(async () => reenter!.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Rotate Primary');

    const input = dialog!.querySelector<HTMLInputElement>('input[type="password"]')!;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, 'synthetic-new-key');
      input.dispatchEvent(new win.Event('input', { bubbles: true }) as unknown as Event);
    });
    await settle();
    const save = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Save key');
    await act(async () => (save as HTMLButtonElement).click());
    await settle(20);
    expect(rotations).toEqual([['account-1', 'lost', 'synthetic-new-key']]);
  });

  test('a viewer who cannot manage the key sees the badge and no remedy', () => {
    rows = [{ secret_id: 'lost', label: 'Primary', status: 'undecryptable', created_by: 'someone-else' }];
    mount(false);
    const [lost] = listItems();
    expect(lost?.textContent).toContain('Undecryptable');
    expect(buttonsIn(lost!)).not.toContain('Re-enter key');
  });
});

describe('a ChatGPT login Dosco cannot decrypt', () => {
  test('its owner sees the badge and Reconnect, and no Re-enter key', () => {
    rows = [{ secret_id: 'login', label: 'My ChatGPT', status: 'undecryptable' }];
    mount(true, true);
    const [login] = listItems();
    expect(login?.textContent).toContain('Undecryptable');
    expect(buttonsIn(login!)).toContain('Reconnect');
    expect(buttonsIn(login!)).not.toContain('Re-enter key');
  });
});

describe('a provider key checked against its provider', () => {
  const checkedAt = '2026-11-11T12:00:00.000Z';
  test('each row says whether the provider accepted, refused or could not check the key', () => {
    rows = [
      { secret_id: 'good', label: 'Good', verification: { status: 'verified', message: 'The provider accepted the key.', checked_at: checkedAt } },
      { secret_id: 'bad', label: 'Bad', verification: { status: 'invalid', message: 'invalid x-api-key', checked_at: checkedAt } },
      { secret_id: 'maybe', label: 'Maybe', verification: { status: 'unknown', message: 'Verification timed out', checked_at: checkedAt } },
      { secret_id: 'never', label: 'Never', verification: null },
    ];
    mount();
    const [good, bad, maybe, never] = listItems();
    expect(good?.textContent).toContain('Verified: Anthropic accepted this key');
    expect(bad?.textContent).toContain('Anthropic refused this key: invalid x-api-key');
    expect(maybe?.textContent).toContain('Not verified: Verification timed out');
    expect(never?.textContent).not.toMatch(/Verified|refused|Not verified/);
  });
});
