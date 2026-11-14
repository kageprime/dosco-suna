import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { tabRoute } from './tab-route';

const P = 'project-1';
const ROUTES = join(import.meta.dir, '../../app/[locale]/(app)/workspaces/[id]');

/** Every `page.tsx` under the project route, as a sample path with ids filled in. */
function projectPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...projectPages(full));
    else if (name === 'page.tsx') out.push(relative(ROUTES, dir));
  }
  return out;
}

function samplePath(route: string): string {
  const segments = route
    .split(sep)
    .filter((s) => s && !/^\(.*\)$/.test(s)) // route groups add no segment
    .map((s) => (s.startsWith('[...') ? 'a/b' : s.startsWith('[') ? 'x1' : s));
  return `/workspaces/${P}${segments.length ? `/${segments.join('/')}` : ''}`;
}

describe('every project page is a named tab', () => {
  const pages = projectPages(ROUTES);

  test('the route folder was found', () => {
    expect(pages.length).toBeGreaterThan(20);
  });

  // A new page under /workspaces/[id] still gets a tab (kind `section`, titled
  // "Page"), but this fails until tab-route.ts gives it a kind, a title and an
  // icon, so the tab reads like the page.
  for (const page of pages) {
    const path = samplePath(page);
    test(path, () => {
      const route = tabRoute(path, P);
      expect(route).not.toBeNull();
      expect(route?.kind).not.toBe('section');
    });
  }
});
