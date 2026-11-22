import { expect, type Page } from '@playwright/test';

/**
 * What a person sees: how many settings navs are on screen, and the open
 * page's column measured against its pane. The column is the outermost
 * box with a max width around the page title; `left` and `right` are the
 * free space beside it, in px.
 */
function settingsLayout(page: Page) {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const box = el.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.right > 0 &&
        box.left < window.innerWidth &&
        getComputedStyle(el).visibility !== 'hidden' &&
        !el.closest('[inert], [aria-hidden="true"]')
      );
    };
    const navs = [...document.querySelectorAll('nav[aria-label="Workspace settings"]')].filter(shown).length;
    const title = [...document.querySelectorAll('main h1')].find(shown);
    let column: HTMLElement | null = null;
    for (let el = title?.parentElement; el && el.tagName !== 'MAIN'; el = el.parentElement) {
      if (getComputedStyle(el).maxWidth !== 'none') column = el;
    }
    if (!column) return { navs, left: null, right: null };
    let pane = column.parentElement;
    while (pane && pane.tagName !== 'MAIN' && !/auto|scroll/.test(getComputedStyle(pane).overflowY)) {
      pane = pane.parentElement;
    }
    if (!pane) return { navs, left: null, right: null };
    const inner = pane.getBoundingClientRect().left + pane.clientLeft;
    const box = column.getBoundingClientRect();
    return { navs, left: Math.round(box.left - inner), right: Math.round(inner + pane.clientWidth - box.right) };
  });
}

/**
 * Wait until `navs` settings navs are on screen and the open page's column
 * has as much space on its left as on its right.
 */
export async function expectSettingsLayout(page: Page, navs: number, message: string) {
  await expect
    .poll(
      async () => {
        const layout = await settingsLayout(page);
        const centered = layout.left !== null && layout.right !== null && Math.abs(layout.left - layout.right) <= 1;
        return { navs: layout.navs, centered };
      },
      { message, timeout: 30_000 },
    )
    .toEqual({ navs, centered: true });
}
