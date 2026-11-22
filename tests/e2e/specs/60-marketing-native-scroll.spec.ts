import { expect, test, type Page } from '@playwright/test';

// KRTX-4744: marketing pages must scroll like the browser scrolls. The
// marketing, SEO and services shells used to mount a Lenis smooth-scroll
// component that intercepted the wheel and animated the scroll position with
// a lerp. Lenis keeps a `lenis` class on <html> for as long as it drives the
// scroll, so a native page never carries it.

// One route per shell: the marketing shell ('/'), the SEO shell
// ('/use-cases') and the services sales shell ('/services'). Three cold
// `next dev` compiles per journey, not four: the deterministic lane's dev
// server (fs cache off) exceeds its memory on a fourth compile on a small
// box and restarts, which no journey survives.
const SHELL_ROUTES = ['/', '/use-cases', '/services'] as const;

// Hydration adopts the HTML the server sent. React threw it away and rendered
// the page again in the browser whenever a provider above the i18n catalog
// wait changed its context before the catalog loaded (`I18nProvider`): the
// page went blank for up to ~1 s on a cold load, white on loopmaxxing.sh. The
// heading the server sent must be the heading on the hydrated page.
test('the landing page hydrates its server HTML instead of rendering it again', async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      Reflect.set(window, '__serverHeading', document.querySelector('h1'));
    });
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  // The same hydration barrier as below: ConsentGate's mount effect.
  await expect(page.locator('html')).toHaveClass(/consent-enabled/, { timeout: 30_000 });
  const serverHeading = await page.evaluate(() => {
    const heading = Reflect.get(window, '__serverHeading') as Element | null;
    return heading ? { connected: heading.isConnected } : null;
  });
  expect(serverHeading, 'the server HTML has a heading').not.toBeNull();
  expect(serverHeading?.connected, 'the server-rendered heading is still in the document').toBe(true);
});

test('marketing pages scroll natively: no scroll hijack on the wheel', async ({ page }) => {
  for (const route of SHELL_ROUTES) {
    await page.goto(route, { waitUntil: 'networkidle' });

    // Hydration barrier: the shells' ConsentGate adds .consent-enabled to
    // <html> in its mount effect, the same effect pass that (before this
    // change) built the scroll hijack next to it. Wait for it, so the class
    // check below can no longer race a page that has not hydrated yet.
    await expect(page.locator('html')).toHaveClass(/consent-enabled/, { timeout: 30_000 });

    // No hijack at rest: the document root carries no Lenis classes.
    await expect(page.locator('html')).not.toHaveClass(/lenis/);

    // The wheel moves the page, like on every native page. Wheel over the
    // hero heading: plain text, never an inner scroller.
    const heading = page.locator('h1').first();
    const box = await heading.boundingBox();
    if (!box) throw new Error(`the hero heading is not rendered on ${route}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 5_000 })
      .toBeGreaterThan(0);
  }
});
