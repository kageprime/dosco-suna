import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CatalogCard } from './catalog-card';

describe('CatalogCard with an interactive trailing control', () => {
  test('the control is a sibling of the link, never inside it', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard
        title="Resend"
        href="/workspaces/p1/admin/connectors/resend?src=apps"
        trailing={<button type="button">Install</button>}
        trailingInteractive
      />,
    );
    const anchorEnd = markup.indexOf('</a>');
    expect(anchorEnd).toBeGreaterThan(-1);
    // A button inside an anchor is invalid HTML and a hydration error.
    expect(markup.indexOf('<button')).toBeGreaterThan(anchorEnd);
    expect(markup).toContain('href="/workspaces/p1/admin/connectors/resend?src=apps"');
  });

  test('without the flag a linked card keeps its trailing slot inside the link', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard title="Resend" href="/x" trailing={<span>Added</span>} />,
    );
    expect(markup.indexOf('Added')).toBeLessThan(markup.indexOf('</a>'));
  });
});

describe('CatalogCard plain variant', () => {
  test('drops the border fill and shows the subtitle row under the title', () => {
    const markup = renderToStaticMarkup(
      <CatalogCard variant="plain" title="Resend" subtitle={<span>MCP</span>} href="/x" />,
    );
    expect(markup).toContain('border-transparent');
    expect(markup).not.toContain('bg-accent/50');
    expect(markup.indexOf('Resend')).toBeLessThan(markup.indexOf('MCP'));
  });

  test('the default card keeps its outlined look', () => {
    const markup = renderToStaticMarkup(<CatalogCard title="Resend" href="/x" />);
    expect(markup).toContain('bg-accent/50');
    expect(markup).not.toContain('border-transparent');
  });
});

describe('CatalogCard accessible name', () => {
  const description = 'Route code and repository work. Use `git` and **tests** before you hand off.';

  for (const [kind, props] of [
    ['button', { onClick: () => {} }],
    ['link', { href: '/x' }],
    ['link with a trailing control', { href: '/x', trailing: <button type="button">Add</button>, trailingInteractive: true }],
    ['pick-list button', { onClick: () => {}, select: { checked: false, onCheckedChange: () => {}, label: 'Grant coding' } }],
  ] as const) {
    test(`the ${kind} is named by the title and described by the summary`, () => {
      const markup = renderToStaticMarkup(<CatalogCard title="coding" description={description} {...props} />);
      const labelledby = markup.match(/aria-labelledby="([^"]+)"/)?.[1];
      const describedby = markup.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(labelledby).toBeDefined();
      expect(markup).toContain(`id="${labelledby}" class="text-foreground truncate text-sm font-medium">coding<`);
      expect(markup).toContain(`id="${describedby}"`);
    });
  }

  test('the summary shows plain words, not markdown', () => {
    const markup = renderToStaticMarkup(<CatalogCard title="coding" description={description} onClick={() => {}} />);
    expect(markup).toContain('Use git and tests before you hand off.');
    expect(markup).not.toContain('`');
    expect(markup).not.toContain('**');
  });

  test('the description a Tab stop reads is one sentence, not the whole text', () => {
    const long = `Route code work to the right tool. ${'More detail. '.repeat(80)}`;
    const markup = renderToStaticMarkup(<CatalogCard title="coding" description={long} onClick={() => {}} />);
    const describedby = markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(markup).toContain(`id="${describedby}" class="sr-only" aria-hidden="true">Route code work to the right tool.</span>`);
  });

  test('a card without a summary points at no description', () => {
    const markup = renderToStaticMarkup(<CatalogCard title="coding" onClick={() => {}} />);
    expect(markup).not.toContain('aria-describedby');
  });
});
