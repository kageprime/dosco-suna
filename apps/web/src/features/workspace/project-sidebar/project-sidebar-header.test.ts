import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The sidebar header row: search and the panel's own collapse toggle.
 *
 * The who-am-I / where-am-I control (`WorkspaceSwitcher`: account, settings,
 * appearance, logout) lives in the footer, bottom of the panel — a user menu
 * belongs at the bottom, and the header stays two tools. Asserted against the
 * source because the alternative is mounting the whole sidebar (sidebar +
 * auth + query + i18n providers) to observe which controls one header row
 * renders.
 */
const source = readFileSync(join(import.meta.dir, 'project-sidebar.tsx'), 'utf8');

const header = source.slice(source.indexOf('<SidebarHeader'), source.indexOf('</SidebarHeader>'));

/**
 * Comments stripped before the absence checks, same convention as
 * `workspace-vocabulary.test.ts`. This header's own comment explains the old
 * design in prose — "a `<Link>` carrying the Dosco mark" — so an unstripped
 * `.not.toContain('<Link')` fails on the explanation of the thing it is
 * checking was removed.
 */
const headerCode = header.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('project sidebar header', () => {
  test('the header carries tools, not the workspace switcher', () => {
    expect(header).not.toContain('<WorkspaceSwitcher');
    expect(header).toContain("aria-label={t('search')}");
    expect(header).toContain('onClick={toggleSidebar}');
  });

  test('the user control lives in the footer and opens upward', () => {
    const footer = source.slice(source.indexOf('<SidebarFooter'));
    expect(footer).toContain('<WorkspaceSwitcher projectId={projectId} />');
  });

  // The sidebar has exactly one dropdown: the footer user control. No
  // standalone mark button in the header, no second menu anywhere.
  test('exactly one dropdown: the footer user control', () => {
    expect(headerCode).not.toContain('<Icon.Dosco');
    expect(headerCode).not.toContain('<Link');
    expect(headerCode).not.toContain('<WorkspaceSwitcher');
    expect(source).not.toContain('UserMenu');
  });

  // The header row is two icon tools now that the switcher lives in the
  // footer — no dead strip can form beside a control that spans nothing.
  test('no dead strip in the header tools row', () => {
    expect(header).toContain('className="flex shrink-0 items-center gap-0.5"');
    expect(header).not.toContain('min-w-0 flex-1');
    expect(header).not.toContain('max-w-full');
    expect(header).not.toContain('w-fit');
  });

  test('the collapse toggle took the mark button’s place', () => {
    expect(header).toContain('onClick={toggleSidebar}');
    expect(header).toContain('<PanelLeft');
    expect(header).toContain("aria-label={isExpanded ? t('collapse') : t('pin')}");
  });

  // ⌘K is otherwise the palette's only entry point, which is invisible to
  // anyone who does not already know it exists.
  test('a search control opens the command palette', () => {
    expect(header).toContain("aria-label={t('search')}");
    expect(header).toContain('<MagnifyingGlassIcon');
    expect(header).toContain('onClick={handleOpenSearch}');
    expect(source).toContain('openCommandPalette()');
  });

  // No keystroke exists on touch, so the button is the only way in there.
  test('search renders on mobile too, unlike the collapse toggle', () => {
    const search = header.slice(header.indexOf("aria-label={t('search')}"));
    expect(search.indexOf('{!isMobile && (')).toBeGreaterThan(-1);
    const beforeSearch = header.slice(0, header.indexOf("aria-label={t('search')}"));
    expect(beforeSearch).not.toContain('{!isMobile && (');
  });

  // Mobile renders the panel as a Sheet: no docked state to collapse, and
  // `state` there still reads the desktop cookie. Same reason the session
  // header's own toggle exempts mobile from its docked-open gate.
  test('the toggle is desktop-only', () => {
    expect(header).toContain('{!isMobile && (');
  });
});
