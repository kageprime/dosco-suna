import { describe, expect, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';

import { NotFoundState } from '@/components/common/not-found-state';
import { loadMessages } from '@/i18n/messages';

import { notFoundMessages } from './not-found-messages';

// The root 404 page (app/not-found.tsx) has no [locale] layout above it, so it
// wraps NotFoundState in its own provider with only these strings. A string
// NotFoundState renders but the subset lacks would show as a raw key there.
describe('the root 404 page carries every string NotFoundState renders', () => {
  test.each(['en', 'de'] as const)('%s', async (locale) => {
    const messages = notFoundMessages(await loadMessages(locale));
    const errors: string[] = [];
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC" onError={(error) => errors.push(error.message)}>
        <NotFoundState />
      </NextIntlClientProvider>,
    );
    expect(errors).toEqual([]);
    expect(html).not.toContain('hardcodedUi.');
    expect(JSON.stringify(messages).length).toBeLessThan(2_000);
    if (locale === 'en') {
      for (const text of ['404 Page not found', 'The page you are looking for does not exist.', 'Go back to home', 'Documentation']) {
        expect(html).toContain(text);
      }
    }
  });
});
