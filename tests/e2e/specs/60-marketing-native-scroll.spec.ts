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
