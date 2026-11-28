import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

let path = '/workspaces/demo/goals';
let search = new URLSearchParams('sort=name');
const pushed: string[] = [];
mock.module('next/navigation', () => ({
  usePathname: () => path,
  useSearchParams: () => search,
  useRouter: () => ({ push: (href: string) => pushed.push(href) }),
}));
mock.module('next/link', () => ({ default: (props: object) => createElement('a', props) }));
const { InboxLink } = await import('./inbox-link');
const { inboxReturnHref } = await import('./inbox-navigation');
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

test('the real Inbox link refreshes its return route for distinct callers', async () => {
  for (const [pathname, query, hash] of [
    ['/workspaces/demo/goals', 'sort=name', '#active'],
    ['/workspaces/demo/files', 'path=%2Fnotes', ''],
    ['/de/workspaces/demo/goals', 'sort=name', '#active'],
    ['/ja/projects/demo/files', 'path=%2Fnotes', '#details'],
  ]) {
    path = pathname;
    search = new URLSearchParams(query);
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { pathname, search: `?${query}`, hash } },
    });
    let tree: ReturnType<typeof create> | undefined;
    await act(async () => {
      tree = create(createElement(InboxLink, null, 'Inbox'));
    });
    const anchor = tree?.root.findByType('a');
    expect(anchor).toBeDefined();
    if (!anchor) throw new Error('Inbox link missing');
    const href = new URL(anchor.props.href, 'https://kortix.test');
    expect(inboxReturnHref(href.searchParams.get('from'))).toBe(`${pathname}?${query}`);
    let prevented = false;
    anchor.props.onNavigate({
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
    const clicked = new URL(pushed.at(-1) ?? '', 'https://kortix.test');
    expect(inboxReturnHref(clicked.searchParams.get('from'))).toBe(`${pathname}?${query}${hash}`);
    await act(async () => tree?.unmount());
  }
});
