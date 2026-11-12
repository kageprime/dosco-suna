import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import React, { act, forwardRef, type ReactNode } from 'react';
import type { Container, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * Characterization for `/tunnel/authorize/[code]` (KRTX-4721): the device-code
 * shell — code, countdown, approve/deny pair, error strip — is pinned BEFORE
 * the dedupe moves the shell into `@kortix/ui/internal/auth/auth-primitives`.
 * The assertions must read the same before and after; no expectation changes.
 */

// happy-dom window: the RadioGroup and sonner read DOM globals at effect
// and import time, and react-test-renderer has none. Same setup as
// `components/iam/audit-session-picker.test.tsx`.
const win = new Window({ width: 1440, height: 900 });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
globals.getComputedStyle = win.getComputedStyle.bind(win);
for (const key of Object.getOwnPropertyNames(win)) {
  if (/^[A-Z]/.test(key) && (!(key in globals) || key.endsWith('Event'))) {
    globals[key] = Reflect.get(win, key);
  }
}
const { createRoot } = await import('react-dom/client');

// A fixed "now" so the countdown text is deterministic in both the hand-rolled
// ticker (before) and the shared `useNow` (after): the clock is frozen below.
const FIXED_NOW = 1_800_000_000_000;

const info = {
  deviceCode: 'ABCD-1234',
  machineHostname: 'marko-macbook',
  projectId: null,
  status: 'pending' as const,
  expiresAt: new Date(FIXED_NOW + 15 * 60 * 1000).toISOString(),
  createdAt: new Date(FIXED_NOW - 60 * 1000).toISOString(),
};
const state = { approveError: null as string | null };
const approveCalls: unknown[] = [];
const denyCalls: unknown[] = [];

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ code: 'ABCD-1234' }),
  usePathname: () => '/tunnel/authorize/ABCD-1234',
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'member@example.test' }, isLoading: false }),
}));
// The real barrel re-exports all of `@kortix/sdk/react` (including `useNow`,
// which the page reads after the dedupe); override only the three data hooks.
const realTunnelHooks = await import('@/hooks/tunnel/use-tunnel');
mock.module('@/hooks/tunnel/use-tunnel', () => ({
  ...realTunnelHooks,
  useDeviceAuthInfo: () => ({ data: info, isLoading: false, error: null }),
  useApproveDeviceAuth: () => ({
    mutateAsync: async (args: unknown) => {
      approveCalls.push(args);
      return {};
    },
    isPending: false,
    error: state.approveError ? new Error(state.approveError) : null,
  }),
  useDenyDeviceAuth: () => ({
    mutateAsync: async (code: unknown) => {
      denyCalls.push(code);
      return {};
    },
    isPending: false,
    error: null,
  }),
}));
mock.module('@/features/workspace/project-selector/use-project-selector-data', () => ({
  useProjectSelectorData: () => ({ openable: [] }),
}));
mock.module('@kortix/ui/workspace', () => ({
  PROJECT_ACTIONS: { PROJECT_CONNECTOR_CONNECTIONS_MANAGE: 'project_connector_connections_manage' },
  useProjectCan: () => ({ allowed: false }),
}));
// The capability list renders its own queries; only its presence is this
// page's contract.
mock.module('@kortix/ui/internal/tunnel/computer-connect', () => ({
  ComputerCapabilities: () => React.createElement('div', { 'data-testid': 'capabilities-stub' }),
}));

// motion/react: render the same tag with the animation-only props stripped,
// and always claim reduced motion so no animation timing runs.
const MOTION_ONLY_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'variants',
  'whileHover',
  'whileTap',
  'whileInView',
  'viewport',
  'layout',
  'layoutId',
]);
const motionComponents = new Proxy(
  {},
  {
    get: (_target, tag: string) =>
      forwardRef(function MotionStub(motionProps: Record<string, unknown>, ref) {
        const domProps = Object.fromEntries(
          Object.entries(motionProps).filter(([key]) => !MOTION_ONLY_PROPS.has(key)),
        );
        return React.createElement(tag, { ...domProps, ref });
      }),
  },
);
const realMotion = await import('motion/react');
mock.module('motion/react', () => ({
  ...realMotion,
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  LazyMotion: ({ children }: { children: ReactNode }) => <>{children}</>,
  m: motionComponents,
  animate: () => Promise.resolve(),
  useReducedMotion: () => true,
}));

const { default: DeviceAuthorizePage } = await import('./page');

let realNow: typeof Date.now;
beforeAll(() => {
  realNow = Date.now;
  Date.now = () => FIXED_NOW;
});
afterAll(() => {
  Date.now = realNow;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

async function render() {
  host = win.document.createElement('div') as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
  root = createRoot(host as unknown as Container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <DeviceAuthorizePage />
      </QueryClientProvider>,
    );
  });
}

async function unmount() {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
}

const bodyText = () => (host?.textContent ?? '').replace(/\s+/g, ' ');

function buttonWithText(label: string): HTMLButtonElement {
  const hits = [...win.document.body.querySelectorAll('button')].filter((button) =>
    button.textContent?.includes(label),
  );
  if (hits.length === 0) throw new Error(`no button labelled ${label}`);
  return hits[0] as unknown as HTMLButtonElement;
}

test('pending request renders the code, the countdown, the name field and the pair', async () => {
  state.approveError = null;
  approveCalls.length = 0;
  denyCalls.length = 0;
  await render();
  const text = bodyText();
  expect(text).toContain('ABCD-1234');
  expect(text).toContain('15:00');
  // The name lives in the input's value, not the text.
  const nameField = win.document.body.querySelector('#connection-name') as unknown as HTMLInputElement;
  expect(nameField?.value).toBe('marko-macbook');
  expect(text).toContain('You approve as member@example.test. The computer joins this account.');
  expect(text).toContain('Approve connection');
  expect(text).toContain('Deny request');
  expect(text).toContain('Who can use this computer');
  await unmount();
});

test('approve sends code, name, capabilities and share, then shows the approved screen', async () => {
  approveCalls.length = 0;
  denyCalls.length = 0;
  await render();
  await act(async () => {
    buttonWithText('Approve connection').click();
  });
  expect(approveCalls).toEqual([
    { code: 'ABCD-1234', name: 'marko-macbook', capabilities: ['filesystem', 'shell', 'desktop'], share: 'me' },
  ]);
  // The decision ends the interaction: the approved status screen stands.
  expect(bodyText()).toContain('Device authorized');
  expect(bodyText()).not.toContain('Deny request');
  await unmount();
});

test('deny sends the code, then shows the denied screen', async () => {
  approveCalls.length = 0;
  denyCalls.length = 0;
  await render();
  await act(async () => {
    buttonWithText('Deny request').click();
  });
  expect(denyCalls).toEqual(['ABCD-1234']);
  expect(approveCalls).toEqual([]);
  expect(bodyText()).toContain('Request denied');
  await unmount();
});

test('an approve failure renders its error strip above the pair', async () => {
  state.approveError = 'Approval failed';
  await render();
  expect(bodyText()).toContain('Approval failed');
  await unmount();
  state.approveError = null;
});
