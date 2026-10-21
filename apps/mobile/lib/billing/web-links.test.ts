import { describe, expect, test } from 'bun:test';

// A local `.env` points the app at a local web server. Links that send the
// user to a web page must ignore it: the page is on dosco.live.
process.env.EXPO_PUBLIC_FRONTEND_URL = 'http://localhost:3000';

const { KORTIX_WEB_URL } = await import('@/lib/kortix-web');
const { getWebBillingUrl, getWebContactSalesUrl, getWebCreditsExplainedUrl } = await import('./web-links');

describe('web links', () => {
  test('the web origin is dosco.live', () => {
    expect(KORTIX_WEB_URL).toBe('https://dosco.live');
  });

  test('every billing link opens dosco.live, never the local frontend', () => {
    expect(getWebBillingUrl()).toBe('https://dosco.live/settings/billing');
    expect(getWebContactSalesUrl()).toBe('https://dosco.live/contact');
  });

  test('credits explained opens the credits docs directly, not the old redirecting path', () => {
    expect(getWebCreditsExplainedUrl()).toBe('https://dosco.live/docs/credits');
  });
});
