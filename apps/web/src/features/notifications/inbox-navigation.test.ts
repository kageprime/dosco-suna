import { expect, test } from 'bun:test';
import { locales } from '@/i18n/catalog.mjs';
import { inboxHref, inboxReturnHref } from './inbox-navigation';

test('Inbox returns to each exact originating workspace route', () => {
  for (const path of [
    '/workspaces/demo/goals?sort=name#active',
    '/workspaces/demo/files?path=%2Fnotes',
  ]) {
    const link = new URL(inboxHref(path), 'https://kortix.test');
    expect(link.pathname).toBe('/inbox');
    expect(inboxReturnHref(link.searchParams.get('from'))).toBe(path);
  }
});

test('direct entry and unsafe destinations fall back to workspaces', () => {
  for (const path of [
    null,
    '',
    'https://outside.test',
    '//outside.test',
    '/\\outside.test',
    '/inbox',
    '/inbox?from=/inbox',
    '/inbox/',
    '/en/inbox',
    '/auth',
    '/workspaces/../inbox',
    '/de/inbox',
    '/de/workspaces/../inbox',
    '/xx/workspaces/demo',
    '/de//outside.test',
  ]) {
    expect(inboxReturnHref(path)).toBe('/workspaces');
  }
});

test('supported locale prefixes preserve workspace and legacy project origins', () => {
  for (const locale of locales) {
    for (const root of ['workspaces', 'projects']) {
      const path = `/${locale}/${root}/demo/goals?sort=name#active`;
      const link = new URL(inboxHref(path), 'https://kortix.test');
      expect(inboxReturnHref(link.searchParams.get('from'))).toBe(path);
    }
  }
});
