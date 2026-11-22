/**
 * What may leave the browser for PostHog: which hosts report, how the cookie
 * banner's answer is read, and how URLs and autocapture events are reduced on
 * pages that carry customer data or one-time tokens, and which sessions a
 * recording keeps and what it hides.
 */
import { describe, expect, test } from 'bun:test';

import {
  maskReplayText,
  POSTHOG_PROJECT_KEY,
  posthogProjectForHost,
  readAnalyticsConsent,
  REPLAY_RATES,
  replayAttribute,
  replayMasksPage,
  replayTier,
  routeTemplate,
  sanitizeUrl,
  scrubEvent,
  sessionFraction,
  shouldRecordSession,
} from './posthog-config';
import { UiTextIndex } from './replay-text';

const ORIGIN = 'https://kortix.com';

/** Our interface text for these tests: two labels and a counted one. */
function uiText(): UiTextIndex {
  const ui = new UiTextIndex([]);
  ui.addCatalog({ save: 'Save changes', close: 'Close', files: '{count} files' }, 'en');
  return ui;
}

describe('posthogProjectForHost', () => {
  test('only kortix.com and loopmaxxing.sh report, as production', () => {
    expect(posthogProjectForHost('kortix.com', undefined)).toEqual({
      key: POSTHOG_PROJECT_KEY,
      environment: 'production',
      replay: true,
    });
    expect(posthogProjectForHost('www.kortix.com', undefined)?.environment).toBe('production');
    expect(posthogProjectForHost('loopmaxxing.sh', undefined)?.environment).toBe('production');
    expect(posthogProjectForHost('www.loopmaxxing.sh', undefined)?.environment).toBe('production');
    expect(posthogProjectForHost('evil-loopmaxxing.sh', undefined)).toBeNull();
  });

  test('dev and staging never report', () => {
    expect(posthogProjectForHost('dev.kortix.com', undefined)).toBeNull();
    expect(posthogProjectForHost('staging.kortix.com', undefined)).toBeNull();
    expect(posthogProjectForHost('dev.kortix.com', 'phc_local')).toBeNull();
  });

  test('a self-hosted or preview host never reports, even with the local key set', () => {
    expect(posthogProjectForHost('kortix.acme-corp.internal', 'phc_local')).toBeNull();
    expect(posthogProjectForHost('pr-123.preview.kortix.dev', 'phc_local')).toBeNull();
    expect(posthogProjectForHost('evil-kortix.com', undefined)).toBeNull();
  });

  test('localhost reports only with an explicit local key', () => {
    expect(posthogProjectForHost('localhost', undefined)).toBeNull();
    expect(posthogProjectForHost('localhost', 'not-a-key')).toBeNull();
    expect(posthogProjectForHost('localhost', 'phc_local')).toEqual({
      key: 'phc_local',
      environment: 'local',
      replay: true,
    });
  });

  test('loopmaxxing.sh is not recorded: its cookie banner does not load there', () => {
    expect(posthogProjectForHost('www.kortix.com', undefined)?.replay).toBe(true);
    expect(posthogProjectForHost('loopmaxxing.sh', undefined)?.replay).toBe(false);
    expect(posthogProjectForHost('www.loopmaxxing.sh', undefined)?.replay).toBe(false);
  });
});

describe('readAnalyticsConsent', () => {
  const cookie = (value: string) =>
    `sb-x=1; cookieyes-consent=${encodeURIComponent(value)}; other=2`;

  test('no banner cookie is unknown', () => {
    expect(readAnalyticsConsent('sb-x=1')).toBe('unknown');
  });

  test('an accepted analytics category is granted', () => {
    expect(
      readAnalyticsConsent(
        cookie('consentid:abc,consent:yes,action:yes,necessary:yes,analytics:yes'),
      ),
    ).toBe('granted');
  });

  test('a rejection after an answer is denied', () => {
    expect(
      readAnalyticsConsent(
        cookie('consentid:abc,consent:no,action:yes,necessary:yes,analytics:no'),
      ),
    ).toBe('denied');
  });

  test('no answer yet in an opt-in region is unknown', () => {
    expect(readAnalyticsConsent(cookie('consentid:abc,consent:no,action:no,analytics:no'))).toBe(
      'unknown',
    );
  });

  test('a malformed cookie is unknown', () => {
    expect(readAnalyticsConsent('cookieyes-consent=%E0%A4%A')).toBe('unknown');
  });
});

describe('URL reduction', () => {
  test('private paths become route templates, locale prefix removed', () => {
    expect(routeTemplate('/de/workspaces/9f1c/sessions/4a2b')).toBe('/workspaces/:id/sessions/:id');
    expect(routeTemplate('/workspaces/9f1c/customize/agents/acme-sales-bot')).toBe(
      '/workspaces/:id/customize/agents/:id',
    );
    expect(routeTemplate('/settings/billing')).toBe('/settings/billing');
  });

  test('a capability token never survives', () => {
    expect(sanitizeUrl('https://kortix.com/share/session/tok_secret123', ORIGIN)).toBe(
      'https://kortix.com/share/session/:id',
    );
    expect(sanitizeUrl('/secret-intake/abc.def', ORIGIN)).toBe(
      'https://kortix.com/secret-intake/:id',
    );
  });

  test('only campaign parameters survive the query, and never the hash', () => {
    expect(
      sanitizeUrl(
        'https://kortix.com/auth?email=a%40b.com&returnUrl=%2Fworkspaces%2Fx&utm_source=youtube&gclid=g1#token',
        ORIGIN,
      ),
    ).toBe('https://kortix.com/auth?utm_source=youtube&gclid=g1');
  });

  test('public marketing paths keep their real path', () => {
    expect(sanitizeUrl('https://kortix.com/blog/launch-week?utm_campaign=v1', ORIGIN)).toBe(
      'https://kortix.com/blog/launch-week?utm_campaign=v1',
    );
  });

  test('another origin keeps origin and path only', () => {
    expect(sanitizeUrl('https://www.google.com/search?q=private+words', ORIGIN)).toBe(
      'https://www.google.com/search',
    );
  });

  test('PostHog markers pass through unchanged', () => {
    expect(sanitizeUrl('$direct', ORIGIN)).toBe('$direct');
  });
});

describe('scrubEvent', () => {
  test('a private-page autocapture loses title, element text and link targets', () => {
    const event = scrubEvent(
      {
        event: '$autocapture',
        properties: {
          $current_url: 'https://kortix.com/workspaces/p1/spaces/q3-board-plan?x=1',
          $pathname: '/workspaces/p1/spaces/q3-board-plan',
          title: 'Q3 board plan · Acme',
          $el_text: 'Acme layoffs.xlsx',
          $elements_chain:
            'a.file-row:attr__class="file-row"attr__href="/workspaces/p1/files/Acme%20layoffs.xlsx"href="/workspaces/p1/files/Acme%20layoffs.xlsx"nth-child="2"nth-of-type="1"text="Acme layoffs.xlsx";div.list:nth-child="1"',
        },
      },
      ORIGIN,
    );
    expect(event.properties.$current_url).toBe('https://kortix.com/workspaces/:id/spaces/:id');
    expect(event.properties.$pathname).toBe('/workspaces/:id/spaces/:id');
    expect(event.properties.title).toBeUndefined();
    expect(event.properties.$el_text).toBeUndefined();
    const chain = String(event.properties.$elements_chain);
    expect(chain).not.toContain('Acme');
    expect(chain).not.toContain('href');
    expect(chain).toContain('a.file-row:attr__class="file-row"');
    expect(chain).toContain('nth-child="2"');
  });

  test('initial person properties are reduced too', () => {
    const event = scrubEvent(
      {
        event: '$identify',
        properties: {
          $current_url: 'https://kortix.com/workspaces/p1',
          $pathname: '/workspaces/p1',
        },
        $set_once: {
          $initial_current_url: 'https://kortix.com/auth?email=a%40b.com&utm_source=meta',
          $initial_pathname: '/connect/tok_1',
          $initial_referrer: '$direct',
        },
      },
      ORIGIN,
    );
    expect(event.$set_once).toEqual({
      $initial_current_url: 'https://kortix.com/auth?utm_source=meta',
      $initial_pathname: '/connect/:id',
      $initial_referrer: '$direct',
    });
  });

  test('a public-page click keeps its text', () => {
    const event = scrubEvent(
      {
        event: '$autocapture',
        properties: {
          $current_url: 'https://kortix.com/pricing',
          $pathname: '/pricing',
          $el_text: 'Start free',
        },
      },
      ORIGIN,
    );
    expect(event.properties.$el_text).toBe('Start free');
  });

  test('a private-page click keeps interface text and loses customer text', () => {
    const click = (elText: string, chain: string) =>
      scrubEvent(
        {
          event: '$autocapture',
          properties: {
            $current_url: 'https://kortix.com/workspaces/p1/settings',
            $pathname: '/workspaces/p1/settings',
            $el_text: elText,
            $elements_chain: chain,
          },
        },
        ORIGIN,
        uiText(),
      ).properties;

    const save = click(
      'Save changes',
      'button.primary:attr__aria-label="Close"nth-child="1"text="Save changes";form:text="Zephyrine Quillfeather"',
    );
    expect(save.$el_text).toBe('Save changes');
    expect(String(save.$elements_chain)).toBe(
      'button.primary:attr__aria-label="Close"nth-child="1"text="Save changes";form:',
    );

    const row = click(
      'Zephyrine roadmap.xlsx',
      'a.row:href="/workspaces/p1/files/x"text="12 files"',
    );
    expect(row.$el_text).toBeUndefined();
    expect(String(row.$elements_chain)).toBe('a.row:text="12 files"');
  });
});

describe('session replay: which sessions are recorded', () => {
  const NOW = Date.parse('2026-11-19T12:00:00Z');
  // Time-ordered ids shaped like posthog-js session ids (UUIDv7).
  const ids = Array.from({ length: 20_000 }, (_, i) => {
    const time = (NOW + i * 997).toString(16).padStart(12, '0');
    const rest = (i * 2654435761).toString(16).padStart(20, '0').slice(-20);
    return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${rest.slice(0, 3)}-8${rest.slice(3, 6)}-${rest.slice(8, 20)}`;
  });
  const share = (tier: keyof typeof REPLAY_RATES) =>
    ids.filter((sessionId) =>
      shouldRecordSession({ replay: true, consent: 'unknown', tier, sessionId }),
    ).length / ids.length;

  test('the tier follows the sign-up date', () => {
    expect(replayTier(null, NOW)).toBe('anonymous');
    expect(replayTier('2026-11-10T09:00:00Z', NOW)).toBe('new_user');
    expect(replayTier('2026-11-05T11:00:00Z', NOW)).toBe('signed_in');
    expect(replayTier('not a date', NOW)).toBe('signed_in');
  });

  test('each tier records about its share of sessions', () => {
    expect(share('new_user')).toBe(1);
    expect(share('signed_in')).toBeGreaterThan(0.09);
    expect(share('signed_in')).toBeLessThan(0.11);
    expect(share('anonymous')).toBeGreaterThan(0.015);
    expect(share('anonymous')).toBeLessThan(0.025);
  });

  test('a session recorded while anonymous stays recorded after sign-in', () => {
    for (const sessionId of ids) {
      if (sessionFraction(sessionId) < REPLAY_RATES.anonymous) {
        expect(sessionFraction(sessionId)).toBeLessThan(REPLAY_RATES.signed_in);
      }
    }
  });

  test('a rejection in the banner, or a host without replay, records nothing', () => {
    for (const sessionId of ids.slice(0, 500)) {
      expect(
        shouldRecordSession({ replay: true, consent: 'denied', tier: 'new_user', sessionId }),
      ).toBe(false);
      expect(
        shouldRecordSession({ replay: false, consent: 'granted', tier: 'new_user', sessionId }),
      ).toBe(false);
    }
  });
});

describe('session replay: what a recording hides', () => {
  test('a signed-in person is masked everywhere; an anonymous visitor on private and sign-in pages', () => {
    expect(replayMasksPage('/pricing', true)).toBe(true);
    expect(replayMasksPage('/pricing', false)).toBe(false);
    expect(replayMasksPage('/', false)).toBe(false);
    expect(replayMasksPage('/auth', false)).toBe(true);
    expect(replayMasksPage('/de/auth/callback', false)).toBe(true);
    expect(replayMasksPage('/share/8f2c1d', false)).toBe(true);
    expect(replayMasksPage('/secret-intake/tok_123', false)).toBe(true);
    expect(replayMasksPage('/inbox', false)).toBe(true);
    expect(replayMasksPage('/authors', false)).toBe(false);
  });

  test('masked text keeps its shape and loses every character', () => {
    expect(maskReplayText('Q3 launch plan for Acme Co')).toBe('** ****** **** *** **** **');
    expect(maskReplayText('  ')).toBe('  ');
  });

  test('text-bearing attributes are hidden on a masked page', () => {
    for (const name of [
      'title',
      'alt',
      'aria-label',
      'placeholder',
      'id',
      'name',
      'data-name',
      'content',
    ]) {
      expect(replayAttribute(name, 'Acme roadmap', true, ORIGIN)).toBe('***');
    }
  });

  test('a text attribute keeps our interface text and hides the rest', () => {
    const ui = uiText();
    expect(replayAttribute('aria-label', 'Close', true, ORIGIN, ui)).toBe('Close');
    expect(replayAttribute('title', '3 files', true, ORIGIN, ui)).toBe('3 files');
    expect(replayAttribute('aria-label', 'Zephyrine Quillfeather', true, ORIGIN, ui)).toBe('***');
    expect(replayAttribute('id', 'workspace-9f1e2d3c', true, ORIGIN, ui)).toBe('***');
    expect(replayAttribute('value', 'Close', true, ORIGIN, ui)).toBe('***');
  });

  test('layout, state and styling attributes stay, so the replay renders', () => {
    expect(replayAttribute('class', 'flex gap-2', true, ORIGIN)).toBe('flex gap-2');
    expect(replayAttribute('data-state', 'open', true, ORIGIN)).toBe('open');
    expect(replayAttribute('viewBox', '0 0 24 24', true, ORIGIN)).toBe('0 0 24 24');
    expect(replayAttribute('rr_width', '120px', true, ORIGIN)).toBe('120px');
    expect(replayAttribute('_cssText', '.a{color:red}', true, ORIGIN)).toBe('.a{color:red}');
  });

  test('style keeps its layout and loses every url()', () => {
    expect(
      replayAttribute(
        'style',
        'width: 40%; background-image: url("https://cdn.example.com/a.png")',
        true,
        ORIGIN,
      ),
    ).toBe('width: 40%; background-image: url()');
  });

  test('links keep our route template; other origins keep only the host', () => {
    expect(
      replayAttribute('href', '/workspaces/9f1e2d3c/sessions/4a5b6c7d?tab=files#x', true, ORIGIN),
    ).toBe('https://kortix.com/workspaces/:id/sessions/:id');
    expect(replayAttribute('src', '/_next/static/media/logo.svg', true, ORIGIN)).toBe(
      'https://kortix.com/_next/static/media/logo.svg',
    );
    expect(replayAttribute('href', 'https://github.com/acme/roadmap', true, ORIGIN)).toBe(
      'https://github.com/',
    );
    expect(replayAttribute('href', 'mailto:someone@example.com', true, ORIGIN)).toBe('');
    expect(replayAttribute('src', 'data:image/png;base64,AAAA', true, ORIGIN)).toBe('');
    expect(replayAttribute('srcset', '/a.png 1x, /b.png 2x', true, ORIGIN)).toBe('');
    expect(replayAttribute('href', '#section-acme', true, ORIGIN)).toBe('#');
  });

  test('a public page keeps its attributes, except values', () => {
    expect(replayAttribute('title', 'Pricing', false, ORIGIN)).toBe('Pricing');
    expect(replayAttribute('href', '/pricing', false, ORIGIN)).toBe('/pricing');
    expect(replayAttribute('value', 'tok_123', false, ORIGIN)).toBe('***');
  });
});
