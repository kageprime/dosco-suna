import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { AdminConnector } from '@kortix/sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { buildRows } from '../../customize/sections/view/secrets-view';
import { setupSteps, type SetupStep } from './setup-steps';

/**
 * The Finish setup modal (KRTX-5190): an unwanted connector request is
 * dismissed per row, stays dismissed after a reload, leaves the other
 * requests actionable, and can be restored and connected later. Skip never
 * signs in or removes the connector.
 */

const browser = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, value });
}

const PROJECT = 'synthetic-workspace';
const connector = (slug: string, name: string, state: AdminConnector['state']): AdminConnector =>
  ({ slug, name, provider: 'mcp', status: state === 'connected' ? 'active' : 'needs_auth', state }) as AdminConnector;
const stepsWith = (deploy: AdminConnector['state']): SetupStep[] =>
  setupSteps({
    connectors: [
      connector('synthetic-deploy', 'Deploy Host', deploy),
      connector('synthetic-tracker', 'Tracker', 'connected'),
      connector('synthetic-git', 'Git Host', 'connected'),
    ],
    secrets: buildRows({ items: [], required: ['SYNTHETIC_TOKEN'], optional: [] }),
    slack: { needed: false, installed: false },
    slackName: 'Slack',
  });

let steps = stepsWith('needs_account');
const connect = mock((_input: unknown) => {});
const sdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({ ...sdkReact, useProjectAccountId: () => 'synthetic-account' }));
const setupStepsHook = await import('./use-setup-steps');
mock.module('./use-setup-steps', () => ({
  ...setupStepsHook,
  useSetupSteps: () => ({ steps, usesSlack: false, loading: false, failed: false, refresh: () => {} }),
}));
const projectCan = await import('../../internal/lib/use-project-can');
mock.module('../../internal/lib/use-project-can', () => ({ ...projectCan, useProjectCan: () => ({ allowed: true }) }));
const addAccount = await import('../../internal/hooks/connectors/use-add-account');
mock.module('../../internal/hooks/connectors/use-add-account', () => ({
  ...addAccount,
  useAddAccount: () => ({ pending: false, submit: connect, proposedLabel: () => 'Everyone' }),
}));
// The modal's own content, not Base UI's portal and transitions.
const shell = (part: string) =>
  function ModalPart({ children, className: _className, ...props }: { children?: ReactNode; className?: string }) {
    return createElement('div', { 'data-part': part, ...props }, children);
  };
mock.module('../../primitives/modal', () => ({
  Modal: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? children : null),
  ModalContent: shell('content'),
  ModalHeader: shell('header'),
  ModalTitle: shell('title'),
  ModalDescription: shell('description'),
}));
const { WorkspaceSetupModal } = await import('./workspace-setup-modal');
const { TestUiHost } = await import('../../test-utils/ui-host');
const { IntlTestProvider } = await import('../../test-utils/intl');
const { defaultUiMessages } = await import('../../i18n');

const modal = () => (
  <QueryClientProvider client={new QueryClient()}>
    <IntlTestProvider locale="en" messages={defaultUiMessages} onError={() => {}}>
      <TestUiHost viewerId="synthetic-user" pathname={`/workspaces/${PROJECT}/setup`}>
        <WorkspaceSetupModal projectId={PROJECT} onClose={() => {}} />
      </TestUiHost>
    </IntlTestProvider>
  </QueryClientProvider>
);
const host = document.createElement('div');
document.body.append(host);
let root = createRoot(host);
const reload = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(modal()));
};

const dialog = () => document.querySelector('[data-testid="workspace-setup"]');
const progress = () => dialog()?.querySelector('aside p')?.textContent;
/** Each section's heading (title + count) and its rows' names and controls. */
const sections = () =>
  Array.from(dialog()?.querySelectorAll('section') ?? []).map((section) => ({
    heading: section.querySelector('h3')?.textContent,
    rows: Array.from(section.querySelectorAll('li')).map((row) =>
      [row.querySelector('p')?.textContent, ...Array.from(row.querySelectorAll('button')).map((b) => b.textContent)].join(' | '),
    ),
  }));
const buttons = () => Array.from(dialog()?.querySelectorAll('button') ?? []);
const labels = () => buttons().map((b) => b.getAttribute('aria-label') ?? b.textContent);
const click = (name: string) => act(async () => buttons().find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)?.click());

afterEach(async () => {
  await act(async () => root.render(null));
  browser.localStorage.clear();
  steps = stepsWith('needs_account');
  connect.mockClear();
});
afterAll(async () => {
  await act(async () => root.unmount());
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('an unwanted connector request is skipped per row, stays skipped after a reload, and is restored', async () => {
  await act(async () => root.render(modal()));
  expect(progress()).toBe('2 of 4 done');
  expect(sections()).toEqual([
    { heading: 'Needs you1', rows: ['SYNTHETIC_TOKEN | Set value'] },
    { heading: 'Optional connectors1', rows: ['Deploy Host | Connect | Skip'] },
  ]);

  await click('Skip Deploy Host');
  const skippedView = [{ heading: 'Needs you1', rows: ['SYNTHETIC_TOKEN | Set value'] }];
  expect(sections()).toEqual(skippedView);
  expect(progress()).toBe('2 of 3 done');
  expect(connect).not.toHaveBeenCalled();

  await reload();
  expect(sections()).toEqual(skippedView);
  expect(progress()).toBe('2 of 3 done');

  await click('Show skipped connectors');
  expect(labels()).not.toContain('Show skipped connectors');
  expect(progress()).toBe('2 of 4 done');
  await click('Connect');
  expect(connect).toHaveBeenCalledTimes(1);
});

test('skipping the last open request completes setup without signing in to it', async () => {
  steps = steps.filter((step) => step.kind !== 'secret');
  await act(async () => root.render(modal()));
  await click('Skip Deploy Host');
  expect(dialog()?.querySelector('[data-part="title"]')?.textContent).toBe('Setup is complete');
  expect(sections()).toEqual([]);
  expect(connect).not.toHaveBeenCalled();
});

test('"Show skipped connectors" shows only while a skipped request is still open', async () => {
  browser.localStorage.setItem(`kortix.setup.skippedConnectors.${PROJECT}`, JSON.stringify(['synthetic-deploy']));
  steps = stepsWith('connected');
  await act(async () => root.render(modal()));
  expect(progress()).toBe('3 of 4 done');
  expect(labels()).not.toContain('Show skipped connectors');
});
