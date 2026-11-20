import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * `/auth` passes its own Deep Forest art into `AuthFrame`. The frame must
 * render that art edge to edge on the showcase half — no photo, no card frame
 * — and keep the editorial photo for every other screen that uses the frame.
 */

const translator = Object.assign((key: string) => key, {
  raw: (key: string) => key,
});
mock.module('../../i18n', () => ({ useTranslations: () => translator }));
mock.module('../desktop/desktop-back-button', () => ({ useDesktopBackTarget: () => {} }));
mock.module('../lib/desktop', () => ({ openExternalRoute: () => false }));
mock.module('../../providers/ui-provider', () => ({
  UiLink: ({ children, ...props }: { children?: React.ReactNode }) =>
    createElement('a', props, children),
}));
mock.module('../../primitives/kortix-logo', () => ({
  KortixLogo: () => createElement('span', null, 'mark'),
}));
mock.module('./auth-art', () => ({ AuthArt: () => null }));

const { AuthFrame } = await import('./auth-card-shell');

const form = () => createElement('div', null, 'form');

describe('AuthFrame showcase slot', () => {
  test('renders a supplied showcase full-bleed, without the photo or its frame', () => {
    const html = renderToStaticMarkup(
      createElement(
        AuthFrame,
        {
          footerVariant: 'none',
          showcase: createElement('div', { 'data-testid': 'forest' }),
        },
        form(),
      ),
    );
    expect(html).toContain('data-testid="forest"');
    expect(html).not.toContain('auth-editorial.jpg');
    expect(html).not.toContain('rounded-xl');
  });

  test('keeps the editorial photo and card frame when no showcase is supplied', () => {
    const html = renderToStaticMarkup(
      createElement(AuthFrame, { footerVariant: 'none', showShowcase: true }, form()),
    );
    expect(html).toContain('auth-editorial.jpg');
    expect(html).toContain('rounded-xl');
    expect(html).not.toContain('data-testid="forest"');
  });
});
