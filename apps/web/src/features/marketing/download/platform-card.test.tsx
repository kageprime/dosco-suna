import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MOBILE_CARD, MOBILE_ROWS } from './content';
import { MOBILE_ORDER } from './detect-os';
import { type CardRow, PlatformCard } from './platform-card';

const Mark = () => <svg />;

/**
 * The mobile rows exactly as `/download` builds them, so this file fails when
 * the page changes, not only when the card does.
 */
const mobileRows: CardRow[] = MOBILE_ORDER.map((os) => ({
  id: os,
  label: MOBILE_ROWS[os].label,
  meta: MOBILE_ROWS[os].hint,
  href: MOBILE_ROWS[os].href,
  Mark,
}));

const mobileCard = renderToStaticMarkup(
  <PlatformCard
    image={null}
    title={MOBILE_CARD.title}
    description={MOBILE_CARD.description}
    rows={mobileRows}
    filled={null}
  />,
);

describe('the mobile card', () => {
  test('is the Android APK only — an internal redirect route, not a store link', () => {
    expect(mobileCard).toContain('href="/download/android"');
    expect(mobileCard).not.toContain('apps.apple.com');
    expect(mobileCard).not.toContain('play.google.com');
    // Internal redirect: same-tab Download, no store "Open".
    expect(mobileCard).not.toContain('target="_blank"');
    expect(mobileCard).not.toContain('aria-label="Open');
    expect(mobileCard).toContain('aria-label="Download Dosco for Android"');
  });

  test("fills the visitor's own platform", () => {
    const onAndroid = renderToStaticMarkup(
      <PlatformCard image={null} title="" description="" rows={mobileRows} filled="android" />,
    );
    expect(onAndroid.match(/ bg-foreground /g)).toHaveLength(1);
    expect(mobileCard).not.toContain(' bg-foreground ');
  });
});

describe('a linked row (component behavior, synthetic fixture)', () => {
  const linked = renderToStaticMarkup(
    <PlatformCard
      image={null}
      title="Mobile app"
      description="…"
      rows={[
        {
          id: 'ios',
          label: 'iOS',
          meta: 'TestFlight · 41 MB',
          href: '/download/ios',
          Mark,
        },
      ]}
      filled="ios"
    />,
  );

  test('still renders the Download link', () => {
    expect(linked).toContain('href="/download/ios"');
    expect(linked).toContain('Download');
    expect(linked).toContain('aria-label="Download Dosco for iOS"');
  });

  test('stays a same-tab Download, not a store Open', () => {
    expect(linked).not.toContain('target="_blank"');
    expect(linked).not.toContain('aria-label="Open');
  });
});

describe('a row without a build yet (synthetic fixture)', () => {
  const soon = renderToStaticMarkup(
    <PlatformCard
      image={null}
      title="Mobile app"
      description="…"
      rows={[
        {
          id: 'ios',
          label: 'iOS',
          meta: 'Universal',
          status: 'Coming soon',
          Mark,
        },
      ]}
      filled={null}
    />,
  );

  test('renders the status pill instead of a button', () => {
    expect(soon).toContain('Coming soon');
    expect(soon).not.toContain('href=');
    expect(soon).not.toContain('Download');
  });
});
