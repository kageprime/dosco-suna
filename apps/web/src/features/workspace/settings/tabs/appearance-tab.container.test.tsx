import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * The container's copy contract (KRTX-4634): `AppearanceTab` translates
 * `DEFAULT_APPEARANCE_TAB_COPY` leaf for leaf — it never keeps a second,
 * hand-built copy table. Every leaf reads the catalog key that leaf's path
 * names (its own path, except the theme picker's search and group captions,
 * which the catalog files under `themes.*`).
 *
 * The container is rendered with a translation hook that records every key
 * it is asked for and answers with that key, so the asked-for key set is
 * exactly the table walked leaf by leaf: a leaf added to the table without a
 * translation is missing from the set; a stale lookup is extra in it; a
 * hard-coded English leaf shows up in the markup unmarked.
 */

const recorded: string[] = [];
mock.module('@/i18n/use-translations', () => ({
  useLocale: () => 'en',
  useTranslations: (namespace?: string) => {
    const keyFor = (key: string) => (namespace ? `${namespace}.${key}` : key);
    return Object.assign(
      (key: string) => {
        recorded.push(keyFor(key));
        return keyFor(key);
      },
      {
        raw: (key: string) => {
          recorded.push(keyFor(key));
          return keyFor(key);
        },
      },
    );
  },
}));
mock.module('next-themes', () => ({
  useTheme: () => ({ theme: 'system', resolvedTheme: 'light', setTheme: () => {} }),
}));

const { AppearanceTab, DEFAULT_APPEARANCE_TAB_COPY } = await import('./appearance-tab');

const NAMESPACE = 'settings.appearance';

/** The catalog key a copy leaf translates, when it differs from its own path. */
const CATALOG_KEY_ALIASES: Record<string, string> = {
  'themeGroups.kortix': 'themes.kortix',
  'themeGroups.lightThemes': 'themes.lightThemes',
  'themeGroups.darkThemes': 'themes.darkThemes',
  'themeSearch.placeholder': 'themes.search',
  'themeSearch.empty': 'themes.noResults',
};

/** The catalog keys for every leaf of the copy table — the keys the
 *  container must translate, derived from the table alone. */
const expectedLeafKeys = (table: unknown, prefix = ''): string[] => {
  if (typeof table === 'string') return [`${NAMESPACE}.${CATALOG_KEY_ALIASES[prefix] ?? prefix}`];
  return Object.entries(table as Record<string, unknown>).flatMap(([key, value]) =>
    expectedLeafKeys(value, prefix ? `${prefix}.${key}` : key),
  );
};

/** The table's own English values — the strings a hand-built copy would leak. */
const leafValues = (table: unknown): string[] => {
  if (typeof table === 'string') return [table];
  return Object.values(table as Record<string, unknown>).flatMap(leafValues);
};

const renderContainer = () => {
  recorded.length = 0;
  return renderToStaticMarkup(createElement(AppearanceTab));
};

/** This container's own lookups — anything else rendered on the pane (the
 *  header's copy) reads a different namespace and is not the copy table. */
const containerLookups = () => recorded.filter((key) => key.startsWith(`${NAMESPACE}.`));

describe('AppearanceTab copy — one table, translated in place', () => {
  test('the container translates exactly the copy-table leaves — no second table, no stale lookup', () => {
    renderContainer();
    expect(new Set(containerLookups())).toEqual(
      new Set(expectedLeafKeys(DEFAULT_APPEARANCE_TAB_COPY)),
    );
  });

  test('no hardcoded English leaf survives the translation', () => {
    const html = renderContainer();
    for (const english of leafValues(DEFAULT_APPEARANCE_TAB_COPY)) {
      expect(html).not.toContain(`>${english}<`);
    }
  });
});
