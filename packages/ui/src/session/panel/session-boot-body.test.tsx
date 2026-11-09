import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { ReactNode } from 'react';

import type { SessionPanelValue } from './session-panel-provider';

/**
 * While a session's computer boots, the Terminal, Browser and Files cards wear
 * their real chrome over the wake status, and mount nothing that reaches the
 * sandbox. Rendered for real (react-dom on happy-dom). The DOM globals exist
 * before any UI module loads, hence the dynamic imports in `beforeAll`.
 */
const OVERRIDE = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'sessionStorage'];
const saved: Record<string, unknown> = {};

let m: {
  act: typeof import('react').act;
  createRoot: typeof import('react-dom/client').createRoot;
  QueryClient: typeof import('@tanstack/react-query').QueryClient;
  QueryClientProvider: typeof import('@tanstack/react-query').QueryClientProvider;
  UiProvider: typeof import('../../providers/ui-provider').UiProvider;
  SessionPanelContext: typeof import('./session-panel-provider').SessionPanelContext;
  SessionBootGate: typeof import('./session-panel-provider').SessionBootGate;
  SessionDetailPanel: typeof import('./session-detail-panel').SessionDetailPanel;
  SessionFilesBooting: typeof import('./session-files-explorer').SessionFilesBooting;
  AppPreviewBooting: typeof import('./easy/app-preview').AppPreviewBooting;
  SessionBootStatus: typeof import('../status/session-starting-loader').SessionBootStatus;
  usePanelHandoffs: typeof import('./shared/use-panel-handoffs').usePanelHandoffs;
  useKortixComputerStore: typeof import('../../internal/stores/kortix-computer-store').useKortixComputerStore;
  DetailLayer: typeof import('./easy/detail-view').DetailLayer;
  TooltipProvider: typeof import('../../primitives/tooltip').TooltipProvider;
  toolCallBlock: typeof import('@kortix/sdk').toolCallBlock;
};

beforeAll(async () => {
  const win = new Window({ url: 'http://localhost/', width: 1440, height: 900 });
  const g = globalThis as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  const keys = [...OVERRIDE, ...Object.getOwnPropertyNames(w).filter((k) => !(k in g))];
  for (const key of keys) {
    saved[key] = g[key];
    g[key] = key === 'window' ? win : w[key];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
  const query = await import('@tanstack/react-query');
  const provider = await import('./session-panel-provider');
  const sdk = await import('@kortix/sdk');
  m = {
    act: (await import('react')).act,
    createRoot: (await import('react-dom/client')).createRoot,
    QueryClient: query.QueryClient,
    QueryClientProvider: query.QueryClientProvider,
    UiProvider: (await import('../../providers/ui-provider')).UiProvider,
    SessionPanelContext: provider.SessionPanelContext,
    SessionBootGate: provider.SessionBootGate,
    SessionDetailPanel: (await import('./session-detail-panel')).SessionDetailPanel,
    SessionFilesBooting: (await import('./session-files-explorer')).SessionFilesBooting,
    AppPreviewBooting: (await import('./easy/app-preview')).AppPreviewBooting,
    SessionBootStatus: (await import('../status/session-starting-loader')).SessionBootStatus,
    usePanelHandoffs: (await import('./shared/use-panel-handoffs')).usePanelHandoffs,
    useKortixComputerStore: (await import('../../internal/stores/kortix-computer-store')).useKortixComputerStore,
    DetailLayer: (await import('./easy/detail-view')).DetailLayer,
    TooltipProvider: (await import('../../primitives/tooltip')).TooltipProvider,
    toolCallBlock: sdk.toolCallBlock,
  };
  // The built-in tool renderers (GenericTool draws a `prune` call).
  await import('../tool/tools/register');
  PRUNE = m.toolCallBlock({
    type: 'tool',
    tool: 'prune',
    callID: 'call-prune',
    state: { status: 'completed', input: {}, output: 'compacted 2 turns' },
  } as never) as import('@kortix/sdk').ToolCallBlock;
  BASH = m.toolCallBlock({
    type: 'tool',
    tool: 'bash',
    callID: 'call-bash',
    state: { status: 'completed', input: { command: 'ls' }, output: 'files' },
  } as never) as import('@kortix/sdk').ToolCallBlock;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
});

let root: ReturnType<typeof import('react-dom/client').createRoot> | null = null;
afterEach(async () => {
  await m.act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  // Reset the store's focus and panel state between tests.
  m.useKortixComputerStore.setState({ focusedToolCallId: null, isSidePanelOpen: false });
});

const noop = () => {};

function panelValue(overrides: Partial<SessionPanelValue>): SessionPanelValue {
  return {
    sessionId: 'route-session',
    files: [],
    context: [] as unknown as SessionPanelValue['context'],
    apps: [],
    outputsDefaultOpen: false,
    detail: null,
    terminalOpen: false,
    terminalSwap: false,
    openDetail: noop,
    handleOpenOutput: noop,
    closeDetail: noop,
    openTerminal: noop,
    closeTerminal: noop,
    openBrowser: noop,
    openFiles: noop,
    openAudit: noop,
    openReminders: noop,
    openDesktop: noop,
    ...overrides,
  };
}

const client = () => new m.QueryClient({ defaultOptions: { queries: { retry: false } } });

async function render(value: SessionPanelValue, node: ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const queryClient = client();
  const tree = (v: SessionPanelValue) => (
    <m.QueryClientProvider client={queryClient}>
      <m.UiProvider>
        <m.SessionPanelContext.Provider value={v}>{node}</m.SessionPanelContext.Provider>
      </m.UiProvider>
    </m.QueryClientProvider>
  );
  await m.act(async () => {
    root = m.createRoot(host);
    root.render(tree(value));
  });
  return {
    host,
    rerender: (v: SessionPanelValue) => m.act(async () => root?.render(tree(v))),
  };
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
  );

describe('tool cards while the session boots', () => {
  test('no card open: the panel shows the wake status, never a blank panel', async () => {
    const { host } = await render(panelValue({ booting: true }), <m.SessionDetailPanel />);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
  });

  test('Terminal: the real card header, the wake status, a working Close, no shell', async () => {
    let closed = 0;
    const { host } = await render(
      panelValue({ booting: true, terminalOpen: true, closeTerminal: () => closed++ }),
      <m.SessionDetailPanel />,
    );
    expect(host.textContent).toContain('Terminal');
    // One wake status: the home's is not mounted under the open card.
    expect(host.querySelectorAll('[role="status"]').length).toBe(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    expect(host.querySelector('.xterm')).toBeNull();
    const close = button(host, 'Close');
    expect(close?.disabled).toBe(false);
    await m.act(async () => close?.click());
    expect(closed).toBe(1);
  });

  test('Browser: the toolbar is drawn, disabled where it needs the computer; Close works', async () => {
    let closed = 0;
    const { host } = await render(
      panelValue({ booting: true }),
      <m.AppPreviewBooting onClose={() => closed++}>
        <m.SessionBootStatus />
      </m.AppPreviewBooting>,
    );
    const address = host.querySelector('input');
    expect(address?.placeholder).toBe('Type a port, e.g. 3000');
    expect(address?.disabled).toBe(true);
    for (const label of ['Home', 'Refresh', 'Open in a new tab']) {
      expect(button(host, label)?.disabled).toBe(true);
    }
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    await m.act(async () => button(host, 'Close')?.click());
    expect(closed).toBe(1);
  });

  test('Files on All files: tabs, New and View options drawn disabled', async () => {
    const { host } = await render(
      panelValue({ booting: true }),
      <m.SessionFilesBooting mode="files">
        <m.SessionBootStatus />
      </m.SessionFilesBooting>,
    );
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All files', 'Changes']);
    expect(tabs.every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(button(host, 'New')?.disabled).toBe(true);
    expect(button(host, 'View options')?.disabled).toBe(true);
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
  });

  test('open, booted, no detail and no terminal: an explicit empty state, never a blank panel', async () => {
    // The dead-end behind the reported bug: `focusToolCall` opened the panel,
    // the handoff found nothing to show, and the panel sat there blank. The
    // shell must name the state instead of drawing nothing.
    const { host } = await render(panelValue({ booting: false, detail: null, terminalOpen: false }), <m.SessionDetailPanel />);
    expect(host.textContent).toContain('Nothing here yet');
    // The boot status is NOT mounted in this state: booting is false.
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  test('Files on Changes: only the disabled tabs, like the live Changes card; turns live without reopening', async () => {
    const body = (
      <m.SessionBootGate
        boot={
          <m.SessionFilesBooting mode="changes">
            <m.SessionBootStatus />
          </m.SessionFilesBooting>
        }
      >
        <p data-testid="live-explorer">live</p>
      </m.SessionBootGate>
    );
    const { host, rerender } = await render(panelValue({ booting: true }), body);
    const tabs = Array.from(host.querySelectorAll('[role="tab"]'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All files', 'Changes']);
    expect(tabs.every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(button(host, 'New')).toBeUndefined();
    expect(button(host, 'View options')).toBeUndefined();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Starting your session');
    expect(host.querySelector('[data-testid="live-explorer"]')).toBeNull();

    // The computer comes up: the same card body is now the live explorer.
    await rerender(panelValue({ booting: false }));
    expect(host.querySelector('[data-testid="live-explorer"]')).not.toBeNull();
    expect(host.querySelector('[role="tab"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A tool call clicked in the chat must never open an empty right panel.
//
// The chat opens the panel synchronously (`focusToolCall` flips
// `isSidePanelOpen`); the handoff effect then opens a detail — previously ONLY
// when the call's step was found. A call whose step `groupSteps` drops (the
// context-engine bookkeeping tools a chat row still renders) left the panel
// open with nothing on it: the reported bug (KRTX-4464).
// ---------------------------------------------------------------------------

type HandoffArgs = Parameters<typeof m.usePanelHandoffs>[0];

/** A harness that mounts the real handoff hook with fixture data. */
function HandoffsHarness(props: { args: Omit<HandoffArgs, 'openDetail'>; onOpen: (detail: unknown) => void }) {
  m.usePanelHandoffs({ ...props.args, openDetail: props.onOpen as never });
  return null;
}

// The real trigger: a context-engine bookkeeping tool. The chat renders its
// row (GenericTool — no registered renderer, not in HIDDEN_TOOLS) and is
// clickable; `groupSteps` drops it (`familyForTool === 'hidden'`), so the
// step lookup in the handoff used to miss it.
let PRUNE: import('@kortix/sdk').ToolCallBlock;
let BASH: import('@kortix/sdk').ToolCallBlock;

const handoffBaseArgs = {
  sessionId: 'route-session',
  isRunning: false,
  outcome: 'succeeded' as const,
  apps: [],
  files: [],
  detail: null,
  handleOpenOutput: () => {},
  openTerminal: () => {},
  openAudit: () => {},
  openReminders: () => {},
  openDesktop: () => {},
  openBrowser: () => {},
  openFiles: () => {},
} as unknown as Omit<HandoffArgs, 'openDetail' | 'steps' | 'calls'>;

async function renderHandoffs(args: Omit<HandoffArgs, 'openDetail'>, onOpen: (detail: unknown) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const tree = (a: Omit<HandoffArgs, 'openDetail'>, o: (detail: unknown) => void) => (
    <m.QueryClientProvider client={client()}>
      <m.UiProvider>
        <m.TooltipProvider>
          <HandoffsHarness args={a} onOpen={o} />
        </m.TooltipProvider>
      </m.UiProvider>
    </m.QueryClientProvider>
  );
  await m.act(async () => {
    root = m.createRoot(host);
    root.render(tree(args, onOpen));
  });
  return {
    host,
    rerender: (a: Omit<HandoffArgs, 'openDetail'>, o: (detail: unknown) => void) =>
      m.act(async () => root?.render(tree(a, o))),
  };
}

describe('a chat tool-call click lands on panel content', () => {
  test('step found: the step detail opens (unchanged behavior)', async () => {
    const step: import('@kortix/sdk').Step<import('@kortix/sdk').ToolCallBlock> = {
      id: 'call-bash',
      family: 'run',
      label: 'Ran 1 command',
      parts: [BASH],
      status: 'done',
    };
    const state: { opened: { key: string } | null } = { opened: null };
    await renderHandoffs(
      { ...handoffBaseArgs, steps: [step], calls: [BASH] },
      (d) => (state.opened = d as { key: string }),
    );
    await m.act(async () => m.useKortixComputerStore.getState().focusToolCall('call-bash'));
    expect(state.opened?.key).toBe('step:call-bash:call-bash');
    expect(m.useKortixComputerStore.getState().focusedToolCallId).toBeNull();
  });

  test('step dropped (context bookkeeping): the call itself opens, never a blank panel', async () => {
    const opened: Array<{ key: string; title: string; body: ReactNode }> = [];
    await renderHandoffs({ ...handoffBaseArgs, steps: [], calls: [PRUNE] }, (d) => opened.push(d as never));
    await m.act(async () => m.useKortixComputerStore.getState().focusToolCall('call-prune'));
    expect(opened.length).toBe(1);
    expect(opened[0].key).toBe('tool:call-prune');
    // The focus is consumed only once the detail exists.
    expect(m.useKortixComputerStore.getState().focusedToolCallId).toBeNull();

    // The panel RENDERS the call's content: mount the opened detail the way
    // `DetailLayer` frames it and assert the tool view is drawn.
    const detailHost = document.createElement('div');
    document.body.appendChild(detailHost);
    await m.act(async () => {
      const detailRoot = m.createRoot(detailHost);
      detailRoot.render(
        <m.QueryClientProvider client={client()}>
          <m.UiProvider>
            <m.TooltipProvider>
              <m.DetailLayer detail={opened[0] as never} onBack={() => {}} isMobile={false}>
                {null}
              </m.DetailLayer>
            </m.TooltipProvider>
          </m.UiProvider>
        </m.QueryClientProvider>,
      );
    });
    expect(detailHost.textContent).toContain('Prune');
  });

  test('steps not derived yet (streaming race): the focus waits and lands once they arrive', async () => {
    const opened: Array<{ key: string }> = [];
    const { rerender } = await renderHandoffs(
      { ...handoffBaseArgs, steps: [], calls: [] },
      (d) => opened.push(d as { key: string }),
    );
    await m.act(async () => m.useKortixComputerStore.getState().focusToolCall('call-prune'));
    // The panel opened on a call the panel data does not hold yet: nothing to
    // open, and the focus stays armed for the data's arrival.
    expect(opened.length).toBe(0);
    expect(m.useKortixComputerStore.getState().focusedToolCallId).toBe('call-prune');

    // The thread's derivation catches up.
    await rerender({ ...handoffBaseArgs, steps: [], calls: [PRUNE] }, (d) => opened.push(d as { key: string }));
    expect(opened.length).toBe(1);
    expect(opened[0].key).toBe('tool:call-prune');
    expect(m.useKortixComputerStore.getState().focusedToolCallId).toBeNull();
  });
});
