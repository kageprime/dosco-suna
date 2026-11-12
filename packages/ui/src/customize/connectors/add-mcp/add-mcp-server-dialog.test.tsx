import { expect, mock, test } from 'bun:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

/**
 * KRTX-4640: the Add-MCP dialog is the surface a person confirms an agent's
 * `setup_url` draft on (`?custom=1&provider=mcp&url=…`), and the surface that
 * must show what the Connect press is waiting on (the serial network phases:
 * create+sync, account, sign-in) instead of a bare spinner. Rendered here
 * because the sandbox browser cannot complete the page's hydration.
 */

const translations = () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, values?: Record<string, string>) =>
      values ? `${key}:${JSON.stringify(values)}` : key;
    t.raw = (key: string) => key;
    t.rich = (key: string) => key;
    return t;
  },
});
mock.module('../../../../i18n', translations);
mock.module('@kortix/ui/i18n', translations);

const host = (tag: string) =>
  function Collaborator({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) {
    return React.createElement(tag, props, children);
  };
// The Modal primitive renders through a portal: render its body inline instead.
mock.module('../../../primitives/modal', () =>
  Object.fromEntries(
    ['Modal', 'ModalBody', 'ModalContent', 'ModalDescription', 'ModalFooter', 'ModalHeader', 'ModalTitle'].map((name) => [
      name,
      host('div'),
    ]),
  ),
);
// The audience picker is a radio group (DOM-only effects); what it renders
// is not what these assertions read.
mock.module('../../sections/add-account-fields', () => ({ AudienceFields: host('div') }));
// The pending-Connect test owns when the connector create resolves; the dialog's
// real deps go straight to the SDK.
let releaseConnector: (created: unknown) => void = () => {};
mock.module('./add-mcp-server-deps', () => ({
  sdkAddMcpServerDeps: () => ({
    createConnector: () =>
      new Promise((resolve) => {
        releaseConnector = resolve;
      }),
    createMemberAccount: async () => ({ connection_id: 'synthetic-connection' }),
    projectAccount: async () => ({ connection_id: 'synthetic-connection' }),
    grantAccess: async () => {},
    startSignIn: async () => null,
  }),
}));
mock.module('../../../providers/ui-provider', () => ({ useUiRouter: () => ({ push: () => {} }) }));
// The toasts render to the real window: bun's test env has none. What the
// dialog announces there is not what these assertions read.
mock.module('../../../primitives/toast', () => ({
  errorToast: () => {},
  successToast: () => {},
  warningToast: () => {},
}));

import { AddMcpServerDialog } from './add-mcp-server-dialog';
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';

async function render(element: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer: ReactTestRenderer | undefined;
  await act(() => {
    renderer = create(
      React.createElement(QueryClientProvider, { client }, element),
    );
  });
  if (!renderer) throw new Error('Renderer was not created');
  return renderer;
}

function inputValues(renderer: ReactTestRenderer): string[] {
  return renderer.root.findAllByType('input').map((node) => node.props.value ?? '');
}

const baseProps = {
  open: true,
  onOpenChange: () => {},
  takenSlugs: [],
  onAdded: () => {},
};

/** `onOpenChange` calls the test can read back. */
function openChangeSpy() {
  const calls: boolean[] = [];
  return { calls, onOpenChange: (open: boolean) => void calls.push(open) };
}

test('the setup-link draft prefills the URL and name fields (KRTX-4640)', async () => {
  const renderer = await render(
    React.createElement(AddMcpServerDialog, {
      ...baseProps,
      projectId: 'synthetic-project',
      initial: { url: 'https://mcp.example.test/mcp', name: 'Wispr Flow' },
    }),
  );
  const values = inputValues(renderer);
  expect(values).toContain('https://mcp.example.test/mcp');
  expect(values).toContain('Wispr Flow');
});

test('a manual open has no URL pre-filled', async () => {
  const renderer = await render(
    React.createElement(AddMcpServerDialog, { ...baseProps, projectId: 'synthetic-project' }),
  );
  expect(inputValues(renderer)).not.toContain('https://mcp.example.test/mcp');
});

function stageText(renderer: ReactTestRenderer): string | null {
  // `role="status"` matches the FieldDescription component and its host <p>;
  // flatten the subtree so either match reads its text.
  const status = renderer.root.findAll((node) => node.props.role === 'status')[0];
  if (!status) return null;
  const texts: string[] = [];
  const collect = (node: ReactTestInstance) => {
    for (const child of node.children) {
      if (typeof child === 'string') texts.push(child);
      else collect(child);
    }
  };
  collect(status);
  return texts.join('') || null;
}

async function submit(renderer: ReactTestRenderer) {
  const form = renderer.root.findByType('form');
  await act(async () => {
    form.props.onSubmit({ preventDefault: () => {} });
  });
}

test('a pending Connect press names the phase it waits on (KRTX-4640)', async () => {
  const { calls, onOpenChange } = openChangeSpy();
  const renderer = await render(
    React.createElement(AddMcpServerDialog, {
      ...baseProps,
      onOpenChange,
      projectId: 'synthetic-project',
      initial: { url: 'https://mcp.example.test/mcp' },
    }),
  );
  expect(stageText(renderer)).toBeNull();

  await submit(renderer);
  // The connector create is held open: the dialog names the phase instead of a
  // bare spinner — the issue's "the UI shows what it is waiting on" branch.
  expect(stageText(renderer)).toBe('addMcpStageConnector');

  // The create resolves and the rest of the flow (account, sign-in decision,
  // success) drains inside one act: the wait text goes away and the dialog
  // closes itself.
  await act(async () => {
    releaseConnector({ slug: 'mcp-example-test', name: 'Example', syncError: null, signInPending: false, connectionId: 'synthetic-connector' });
    // One macrotask drains the whole resolution chain (react-query + the
    // account step) — counting microtasks here would pin an internal tick
    // count nobody maintains.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(stageText(renderer)).toBeNull();
  expect(calls.at(-1)).toBe(false);
});
