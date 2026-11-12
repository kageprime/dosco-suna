/**
 * KRTX-4736. A signed-in visitor at the marketing landing must never be left
 * on it. The middleware fast path (`pathname === '/' && user`) redirects only
 * when it may resolve the identity; for a session cookie that is expired or
 * inside the refresh margin it must not create an auth client (KRTX-2111), so
 * the request falls through to the statically prerendered landing. The browser
 * then refreshes the session — and until this gate existed, nothing navigated:
 * the visitor stayed on the marketing home with a signed-in navbar (the
 * founder-reported screenshot state).
 *
 * This drives the REAL home page — the route that serves `/` and every locale
 * root — with the auth provider and router mocked, and pins the contract on
 * both sides: a signed-in resolution leaves the landing (pending frame, then
 * `router.replace` into the app destination), a signed-out visitor gets the
 * landing unchanged.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import {
  LAST_PROJECT_COOKIE,
  PROJECT_LANDING_PATH,
} from '@kortix/ui/internal/lib/onboarding/landing-destination';

const win = new Window({ url: 'https://dev.kortix.com/' });
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
globals.location = win.location;
globals.history = win.history;
globals.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
globals.cancelAnimationFrame = (id: number) => clearTimeout(id);
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

const USER_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '319395c1-9c3f-41b4-ac6c-9539a12dbb7c';
/** test-setup.ts pins NEXT_PUBLIC_APP_URL to localhost:3000; the auth cookie name carries the port. */
const AUTH_COOKIE = 'sb-kortix-auth-token-3000';

let authState: { user: { id: string } | null; isLoading: boolean } = {
  user: null,
  isLoading: false,
};
const replaceCalls: string[] = [];

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({
    user: authState.user,
    isLoading: authState.isLoading,
    supabase: {},
    bootstrapError: null,
    retryAuth: () => undefined,
    signOut: () => Promise.resolve(),
  }),
}));
mock.module('next/navigation', () => ({
  useRouter: () => ({
    replace: (href: string) => {
      replaceCalls.push(href);
    },
    push: () => undefined,
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));
// The gate shows the same frame the destination shows. A marker keeps the
// "is the visitor on the landing" assertion exact.
mock.module('@/components/projects/project-pending-screen', () => ({
  ProjectPendingScreen: () => React.createElement('div', { 'data-testid': 'pending-screen' }),
}));
// The marker for "the visitor is reading the landing" is the REAL `PageFrame`
// (`<main>`). The nine landing sections are stubbed: this contract is the gate
// around the page, not the sections' internals, and two of them read CMS/docs
// data no test should need.
const SECTION_STUB = () => null;
for (const [moduleName, names] of [
  ['@/features/marketing/case-studies/case-studies', ['CaseStudies']],
  ['@/features/marketing/landing-hero/sand-band-hero', ['SandBandHero']],
  ['@/features/marketing/landing-sections/faq-section', ['LandingFaqSection']],
  ['@/features/marketing/landing-sections/framework-band', ['FrameworkBand']],
  ['@/features/marketing/landing-sections/how-it-works-tabs', ['HowItWorksTabs']],
  ['@/features/marketing/landing-sections/pillars-band', ['PillarsBand']],
  ['@/features/marketing/landing-sections/trust-band', ['TrustBand']],
  ['@/features/marketing/landing-sections/use-cases-band', ['UseCasesBand']],
  ['@/features/marketing/landing-sections/works-with-strip', ['WorksWithStrip']],
] as const) {
  mock.module(moduleName, () =>
    Object.fromEntries(names.map((name) => [name, SECTION_STUB])),
  );
}

const { default: Home } = await import('./page');

let root: Root | undefined;
let container: HTMLElement | undefined;

async function mountHome() {
  const raw = win.document.createElement('div');
  container = win.document.body.appendChild(raw) as unknown as HTMLElement;
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(Home));
  });
}

function setCookie(name: string, value: string) {
  win.document.cookie = `${name}=${value}; path=/`;
}

function clearCookies() {
  for (const entry of win.document.cookie.split('; ')) {
    const name = entry.split('=')[0];
    if (name) win.document.cookie = `${name}=; path=/; max-age=0`;
  }
}

// The landing renders PageFrame's `<main>`; the held render does not.
const landingMarker = () => container!.querySelector('main');
const pendingScreen = () => container!.querySelector('[data-testid="pending-screen"]');

afterEach(async () => {
  if (root) {
    const r = root;
    root = undefined;
    await act(async () => r.unmount());
  }
  container?.remove();
  container = undefined;
  clearCookies();
  authState = { user: null, isLoading: false };
  replaceCalls.length = 0;
});

describe('the home route and a signed-in visitor', () => {
  test('leaves the landing for the remembered workspace, never staying on the marketing page', async () => {
    setCookie(AUTH_COOKIE, 'session-json');
    setCookie(LAST_PROJECT_COOKIE, encodeURIComponent(`${USER_ID}:${PROJECT_ID}`));
    authState = { user: { id: USER_ID }, isLoading: false };

    await mountHome();

    expect(pendingScreen()).not.toBeNull();
    expect(landingMarker()).toBeNull();
    expect(replaceCalls).toEqual([`/workspaces/${PROJECT_ID}`]);
  });

  test('with no remembered workspace, replaces into the landing door', async () => {
    setCookie(AUTH_COOKIE, 'session-json');
    authState = { user: { id: USER_ID }, isLoading: false };

    await mountHome();

    expect(pendingScreen()).not.toBeNull();
    expect(replaceCalls).toEqual([PROJECT_LANDING_PATH]);
  });

  test('a tampered remembered-workspace cookie never leaves the app paths', async () => {
    setCookie(AUTH_COOKIE, 'session-json');
    // Not a UUID, so the destination helper must ignore it and open the door.
    setCookie(LAST_PROJECT_COOKIE, encodeURIComponent(`${USER_ID}:../../evil`));
    authState = { user: { id: USER_ID }, isLoading: false };

    await mountHome();

    expect(replaceCalls).toEqual([PROJECT_LANDING_PATH]);
  });

  test('holds the landing while the auth provider is still resolving', async () => {
    setCookie(AUTH_COOKIE, 'session-json');
    authState = { user: null, isLoading: true };

    await mountHome();

    expect(pendingScreen()).not.toBeNull();
    expect(landingMarker()).toBeNull();
    expect(replaceCalls).toEqual([]);
  });
});

describe('the home route and a signed-out visitor', () => {
  test('renders the marketing landing unchanged — no hold, no redirect', async () => {
    await mountHome();

    expect(landingMarker()).not.toBeNull();
    expect(pendingScreen()).toBeNull();
    expect(replaceCalls).toEqual([]);
  });

  test('renders the landing once a held session resolves signed-out', async () => {
    setCookie(AUTH_COOKIE, 'session-json');
    authState = { user: null, isLoading: true };

    await mountHome();
    expect(pendingScreen()).not.toBeNull();

    authState = { user: null, isLoading: false };
    await act(async () => {
      root!.render(React.createElement(Home));
    });

    expect(landingMarker()).not.toBeNull();
    expect(pendingScreen()).toBeNull();
    expect(replaceCalls).toEqual([]);
  });
});
