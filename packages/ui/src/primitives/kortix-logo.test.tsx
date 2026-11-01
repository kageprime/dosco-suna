import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KortixLogo } from './kortix-logo';

describe('KortixLogo', () => {
  test('renders wordmark with light-theme image on dark:hidden and dark-theme image on dark:block', () => {
    const html = renderToStaticMarkup(<KortixLogo variant="brandmark" />);
    
    // Light mode element must use the dark-ink mark (dosco-wordmark-light.png)
    expect(html).toContain('src="/brand/dosco-wordmark-light.png"');
    expect(html).toMatch(/src="\/brand\/dosco-wordmark-light\.png"[^>]*class="[^"]*dark:hidden/);

    // Dark mode element must use the white/silver chrome mark (dosco-wordmark-dark.png)
    expect(html).toContain('src="/brand/dosco-wordmark-dark.png"');
    expect(html).toMatch(/src="\/brand\/dosco-wordmark-dark\.png"[^>]*class="[^"]*dark:block/);

    // Alt text defaults to Dosco Tek
    expect(html).toContain('alt="Dosco Tek"');
  });

  test('renders icon with light-theme image on dark:hidden and dark-theme image on dark:block', () => {
    const html = renderToStaticMarkup(<KortixLogo variant="icon" size={24} />);
    
    expect(html).toContain('src="/brand/dosco-icon-light.png"');
    expect(html).toMatch(/src="\/brand\/dosco-icon-light\.png"[^>]*class="[^"]*dark:hidden/);

    expect(html).toContain('src="/brand/dosco-icon-dark.png"');
    expect(html).toMatch(/src="\/brand\/dosco-icon-dark\.png"[^>]*class="[^"]*dark:block/);

    expect(html).toContain('alt="Dosco Tek"');
  });
});
