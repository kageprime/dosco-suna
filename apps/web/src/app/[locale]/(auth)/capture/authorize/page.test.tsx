import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import React, { act, forwardRef, type ReactNode } from 'react';
import type { Container, Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

/**
 * Characterization for `/capture/authorize` (KRTX-4721): the device-code shell
 * — code, countdown, approve/deny pair, error strip — is pinned BEFORE the
 * dedupe moves the shell into `@kortix/ui/internal/auth/auth-primitives`. The
 * assertions must read the same before and after; no expectation is updated.
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
const EXPIRES_AT = new Date(FIXED_NOW + 15 * 60 * 1000).toISOString();

const grant = {
  user_code: 'WXYZ-9876',
  status: 'pending' as const,
  expires_at: EXPIRES_AT,
  device: { name: 'Marko MacBook', os: 'macOS', os_version: null, arch: null, app_version: null },
  account_id: null,
  device_id: null,
  accounts: [{ account_id: 'acct-1', name: 'Acme' }],
};
const state = {
  approveError: null as string | null,
  denyError: null as string | null,
};
const approveCalls: unknown[] = [];
const denyCalls: unknown[] = [];

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams('user_code=WXYZ-9876'),
  useParams: () => ({}),
  usePathname: () => '/capture/authorize',
}));
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'user-1', email: 'member@example.test' }, isLoading: false }),
}));
mock.module('@kortix/ui/internal/capture/use-capture-area', () => ({ deviceOs: () => 'macOS' }));
mock.module('@kortix/ui/workspace/sidebar/use-workspace-directory', () => ({
  useWorkspaceDirectory: () => ({
    loading: false,
    openable: [{ workspaceId: 'ws-1', accountId: 'acct-1', project: { name: 'Acme', icon: null, icon_glyph: null } }],
  }),
}));

// The page (after the dedupe) imports `useNow` from here; keep the real
// module and override only the grant/mutation hooks. With `Date.now` frozen
// the real `useNow` pins to FIXED_NOW, so one code path serves both states.
const realSdkReact = await import('@kortix/sdk/react');
mock.module('@kortix/sdk/react', () => ({
  ...realSdkReact,
  useCaptureDeviceGrant: () => ({ data: grant, isLoading: false, error: null }),
  useApproveCaptureDevice: () => ({
    mutateAsync: async (args: unknown) => {
      approveCalls.push(args);
      return {};
    },
    isPending: false,
    error: state.approveError ? new Error(state.approveError) : null,
  }),
  useDenyCaptureDevice: () => ({
    mutateAsync: async (code: unknown) => {
      denyCalls.push(code);
      return {};
    },
    isPending: false,
    error: state.denyError ? new Error(state.denyError) : null,
  }),
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

const { default: CaptureAuthorizePage } = await import('./page');

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
        <CaptureAuthorizePage />
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

test('pending grant renders the code, the countdown, device and the approve/deny pair', async () => {
  state.approveError = null;
  state.denyError = null;
  await render();
  const text = bodyText();
  expect(text).toContain('WXYZ-9876');
  expect(text).toContain('15:00');
  expect(text).toContain('Marko MacBook · macOS');
  expect(text).toContain('Signing in as member@example.test');
  expect(text).toContain('Approve sign-in');
  expect(text).toContain('Deny');
  expect(text).toContain('Workspace');
  expect(text).toContain('Acme');
  await unmount();
});

test('approve sends the picked workspace account; deny sends the code', async () => {
  approveCalls.length = 0;
  denyCalls.length = 0;
  await render();
  await act(async () => {
    buttonWithText('Approve sign-in').click();
  });
  await act(async () => {
    buttonWithText('Deny').click();
  });
  expect(approveCalls).toEqual([{ userCode: 'WXYZ-9876', accountId: 'acct-1' }]);
  expect(denyCalls).toEqual(['WXYZ-9876']);
  await unmount();
});

test('an approve or deny failure renders its error strip above the pair', async () => {
  state.approveError = 'Approval failed';
  state.denyError = 'Denial failed';
  await render();
  const text = bodyText();
  expect(text).toContain('Approval failed');
  expect(text).toContain('Denial failed');
  await unmount();
  state.approveError = null;
  state.denyError = null;
});
