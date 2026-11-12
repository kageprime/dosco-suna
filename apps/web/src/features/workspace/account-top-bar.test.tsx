import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AccountTopBar } from './account-top-bar';
import { parseSettingsTab, type SettingsTab } from '@kortix/ui/customize/settings/settings-tabs';

/**
 * One copy for every describe block below (each used to carry its own, and
 * the copies drifted): read a file's source with comments stripped, so the
 * prose in a component cannot defeat an absence assertion.
 */
const readSource = async (file: string) => {
  const text = await Bun.file(new URL(file, import.meta.url)).text();
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

const BAR_SOURCE = './account-top-bar.tsx';

/**
 * What is NOT covered here, and why.
 *
 * The menu's rows live inside a `DropdownMenuContent`, which renders
 * nothing until the menu is open and then renders through a portal.
 * `apps/web` has no DOM harness — no jsdom, no testing-library — and
 * `renderToStaticMarkup` returns an empty string for portalled content
 * (`features/layout/user-menu.test.tsx` documents the same limit), so the
 * rows are not reachable from a unit test; the real menu is verified in a
 * browser. What IS reachable is the wiring the rows are built from, which is
 * what the source-scan tests below read. Comments are stripped before
 * matching, so the prose in the component cannot defeat an absence assertion.
 */
describe('AccountTopBar menu rows', () => {
  /**
   * `/workspaces` and `/workspaces/new` mount no `SettingsPanel`, so a row that pokes
   * `useSettingsPanelStore.openSettings()` would set state with no subscriber
   * and the click would be swallowed — the exact dead-store bug
   * `features/layout/user-menu.tsx` documents for its own rows. `/settings/<tab>`
   * is the account-scoped route that mounts the panel itself, so the row
   * navigates to it.
   */
  test('the menu holds a Settings row that navigates to /settings/profile', async () => {
    const code = await readSource(BAR_SOURCE);
    expect(code).toContain('<Link href="/settings/profile" prefetch>');
    expect(code).not.toContain('openSettings');
    expect(code).not.toContain('router.push');
  });

  /**
   * Every tab the rows build a URL from must be a segment
   * `app/[locale]/(app)/settings/[tab]/page.tsx` accepts, or the route silently
   * falls back to `STANDALONE_DEFAULT_SETTINGS_TAB` and the row opens a
   * different tab than it names (the same guard `user-menu.test.tsx` runs).
   */
  test('the tab the rows navigate to is a real /settings segment', async () => {
    const code = await readSource(BAR_SOURCE);
    const tabs = [...code.matchAll(/href="\/settings\/([a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(parseSettingsTab(tab)).toBe(tab as SettingsTab);
    }
  });

  /**
   * Log out ends something, so it keeps its own group after a separator — the
   * row order every other user menu in the app uses (settings first, log out
   * last, nothing below it: the last item in a menu is the one a slipped
   * pointer lands on).
   */
  test('the Settings row sits above the Log out row', async () => {
    const code = await readSource(BAR_SOURCE);
    expect(code).toContain('actions.settings');
    expect(code.indexOf('actions.settings')).toBeLessThan(code.indexOf('onSelect={onLogOut}'));
  });
});

/**
 * KRTX-1742: the Inbox button sits in the trailing group, before the account
 * menu, on `/workspaces` and `/workspaces/new`, and opens the account-level `/inbox` page.
 * It loads client-only, so the static renders of those pages
 * (project-selector.test.tsx) need no query client or auth provider.
 */
describe('AccountTopBar Inbox button', () => {
  test('the Inbox button renders before the account menu, and not on /inbox itself', async () => {
    const code = await readSource(BAR_SOURCE);
    expect(code).toContain('{inbox ? <InboxButton /> : null}');
    expect(code.indexOf('<InboxButton />')).toBeLessThan(code.indexOf('<DropdownMenu>'));
    expect(code).toContain('inbox = true');
    expect(code).not.toContain('NotificationBell');
    const page = await readSource('../../app/[locale]/(app)/inbox/page.tsx');
    expect(page).toContain('inbox={false}');
  });

  test('the Inbox button is a client-only chunk that links to /inbox', async () => {
    const code = await readSource(BAR_SOURCE);
    expect(code).toContain("import('@/features/notifications/inbox-button')");
    expect(code).toContain('{ ssr: false }');
    const button = await readSource('../notifications/inbox-button.tsx');
    expect(button).toContain("ACCOUNT_INBOX_HREF = '/inbox'");
    expect(button).toContain('href={ACCOUNT_INBOX_HREF}');
  });
});

/**
 * KRTX-4492: the profile picture did not reach the identity trigger — the bar
 * rendered text-only on `/workspaces` and `/workspaces/new` even after an
 * upload on /settings/profile. The trigger (unlike the menu rows) is NOT
 * portalled, so a static render reaches it. The Avatar draws the bitmap
 * `<img>` client-side only (fingerprinted after load), which a static render
 * cannot observe; the browser journey (39-profile-avatar-user-menu.spec.ts)
 * asserts the rendered `<img>` with the stored URL.
 */
describe('AccountTopBar identity avatar', () => {
  /**
   * The uploaded picture must reach the bar. Both callers read the same
   * Supabase identity field the profile tab writes (`user_metadata.avatar_url`,
   * `profile-tab.tsx`); the prop is the only path into the component.
   */
  test('the callers pass the profile picture the settings tab stores', async () => {
    const newPage = await readSource('../../features/workspace/new/new-workspace-page.tsx');
    expect(newPage).toContain('user?.user_metadata?.avatar_url');
    const selector = await readSource('../../features/workspace/project-selector/project-selector.tsx');
    expect(selector).toContain('user?.user_metadata?.avatar_url');
    const inboxPage = await readSource('../../app/[locale]/(app)/inbox/page.tsx');
    expect(inboxPage).toContain('user?.user_metadata?.avatar_url');
  });

  const render = (props?: Partial<React.ComponentProps<typeof AccountTopBar>>) =>
    renderToStaticMarkup(
      createElement(AccountTopBar, {
        email: 'user@example.test',
        name: 'Demo User',
        signingOut: false,
        onLogOut: () => {},
        ...props,
      }),
    );

  test('the trigger renders the identity avatar tile', () => {
    expect(render({ avatarUrl: 'https://pics.example.test/u.png' })).toContain('data-slot="avatar"');
  });

  test('the avatar renders without a picture too: the initials tile of every other surface', () => {
    expect(render()).toContain('data-slot="avatar"');
  });
});
