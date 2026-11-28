import { afterEach, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const win = new Window();
Object.defineProperties(globalThis, {
  window: { value: win, configurable: true },
  document: { value: win.document, configurable: true },
  navigator: { value: win.navigator, configurable: true },
  IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true },
});
let pathname = '/';
let user: { id: string } | null = null;
let tracked = 0;
const demos: string[] = [];
const translate = Object.assign((key: string) => key, { raw: (key: string) => key });
mock.module('next/navigation', () => ({ usePathname: () => pathname }));
mock.module('@/i18n/use-translations', () => ({ useTranslations: () => translate }));
mock.module('@/features/providers/auth-provider', () => ({ useAuth: () => ({ user }) }));
mock.module('@/features/contact/request-demo-provider', () => ({ useRequestDemo: () => (input: { source: string }) => demos.push(input.source) }));
mock.module('@/lib/analytics/gtm', () => ({ trackCtaSignup: () => { tracked++; } }));
mock.module('@kortix/ui/internal/lib/onboarding/last-project-cookie', () => ({ latestProjectPath: (id: string) => `/projects/${id}` }));
const { CtaSection } = await import('./cta-section');
let root: Root;
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ''; pathname = '/'; user = null; tracked = 0; demos.length = 0; });
function mount(content?: Parameters<typeof CtaSection>[0]) {
  const host = document.createElement('div'); document.body.appendChild(host);
  act(() => { root = createRoot(host); root.render(<CtaSection {...content} />); });
  return host;
}

test('custom content outranks /about, preserves actions and optional trust', () => {
  pathname = '/about';
  const host = mount({ content: { title: 'Custom title', subtitle: 'Custom subtitle', actions: <button>Copy prompt</button>, trust: 'Custom trust' } });
  expect(host.querySelector('h2')?.textContent).toBe('Custom titleCustom subtitle');
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(host.textContent).toContain('Custom trust');
  act(() => root.render(<CtaSection content={{ title: 'Custom title', subtitle: 'Custom subtitle', actions: <button>Copy prompt</button> }} />));
  expect(host.querySelectorAll('p')).toHaveLength(0);
});
for (const path of ['/about', '/about/', '/en/about', '/de/about/']) {
  test(`pathname override preserves links and external attributes at ${path}`, () => {
    pathname = path;
    const host = mount();
    const links = [...host.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).not.toBe('/auth');
    expect(links[1].getAttribute('target')).toBe('_blank');
    expect(links[1].getAttribute('rel')).toBe('noreferrer');
    expect(host.querySelectorAll('h2')).toHaveLength(1);
    expect(host.querySelectorAll('p')).toHaveLength(0);
  });
}
test('default SSR anchor hydrates to remembered project and retains signup/demo handlers', () => {
  user = { id: 'synthetic-project' };
  expect(renderToStaticMarkup(<CtaSection />)).toContain('href="/auth"');
  const host = mount();
  const link = host.querySelector('a');
  expect(link?.getAttribute('href')).toBe('/projects/synthetic-project');
  act(() => link?.click());
  expect(tracked).toBe(1);
  act(() => host.querySelector('button')?.click());
  expect(demos).toEqual(['footer-cta']);
  expect(host.querySelectorAll('p')).toHaveLength(1);
});
test('signed-out default remains an /auth anchor', () => {
  const host = mount();
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/auth');
});
