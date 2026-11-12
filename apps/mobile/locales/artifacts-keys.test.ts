import { describe, expect, test } from 'bun:test';
import i18next from 'i18next';

import { SUPPORTED_LOCALES } from '@/lib/utils/locale-config';

// Mobile Artifacts (the drawer page, the viewer sheet, its actions sheet):
// every string resolves in every locale from its own bundle. The keys shared
// with web carry web's translations (apps/web/translations).

const KEYS = [
  'artifacts.title',
  'artifacts.search',
  'artifacts.scope.all',
  'artifacts.scope.mine',
  'artifacts.scope.shared',
  'artifacts.scope.pinned',
  'artifacts.type.doc',
  'artifacts.loadError',
  'artifacts.retry',
  'artifacts.empty',
  'artifacts.emptyFiltered',
  'artifacts.scopeEmpty',
  'artifacts.pin',
  'artifacts.unpin',
  'artifacts.pinDone',
  'artifacts.unpinDone',
  'artifacts.rename',
  'artifacts.renamed',
  'artifacts.namePlaceholder',
  'artifacts.save',
  'artifacts.saving',
  'artifacts.cancel',
  'artifacts.shareLink',
  'artifacts.openInBrowser',
  'artifacts.reload',
  'artifacts.notFoundTitle',
  'artifacts.notFoundHint',
  'artifacts.openError',
  'artifacts.actionFailed',
  'artifacts.remove',
  'artifacts.removeTitle',
  'artifacts.removeHint',
  'artifacts.removed',
  'artifacts.more',
  'artifacts.unavailable',
];
// "HTML" is the same word in every locale.
const SAME_IN_EVERY_LOCALE = ['artifacts.type.html'];

async function instanceFor(locale: string) {
  const i18n = i18next.createInstance();
  await i18n.init({
    resources: {
      en: { translation: require('./en.json') },
      [locale]: { translation: require(`./${locale}.json`) },
    },
    lng: locale,
    fallbackLng: 'en',
    compatibilityJSON: 'v4',
    interpolation: { escapeValue: false },
  });
  return i18n;
}

describe('artifacts strings', () => {
  test('English reads as the page and sheets show it', async () => {
    const en = await instanceFor('en');
    expect(en.t('artifacts.title')).toBe('Artifacts');
    expect(en.t('artifacts.scope.mine')).toBe('Yours');
    expect(en.t('artifacts.remove')).toBe('Stop sharing');
    expect(en.t('artifacts.removeHint')).toBe('It leaves Artifacts and its links stop working. Its files stay in Files.');
    expect(en.t('artifacts.shareLink')).toBe('Share link');
  });

  for (const locale of SUPPORTED_LOCALES.filter((locale) => locale !== 'en')) {
    test(`${locale} has its own translation of every key`, async () => {
      const i18n = await instanceFor(locale);
      const en = await instanceFor('en');
      for (const key of [...KEYS, ...SAME_IN_EVERY_LOCALE]) {
        expect(i18n.exists(key, { lng: locale, fallbackLng: false })).toBe(true);
        expect(i18n.t(key).trim().length).toBeGreaterThan(0);
      }
      for (const key of KEYS) expect(i18n.t(key)).not.toBe(en.t(key));
    });
  }
});
