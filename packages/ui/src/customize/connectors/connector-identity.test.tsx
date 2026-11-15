import { describe, expect, test } from 'bun:test';
import type { AdminConnector } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConnectorStatusLogo, ConnectorStatusWord } from './connector-identity';

/**
 * Audit finding: a connector that needed an account showed its state only as
 * an 8 px orange dot; the word was screen-reader text. The state must be
 * visible text (WCAG 1.4.1), and a healthy connector stays quiet.
 */

function connector(patch: Partial<AdminConnector>): AdminConnector {
  return {
    slug: 'brandfetch',
    name: 'Brandfetch',
    provider: 'composio',
    actions: [{ name: 'search' }],
    ...patch,
  } as unknown as AdminConnector;
}

/** Text a sighted user reads: everything outside `.sr-only`. */
function visibleText(html: string): string {
  return html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

describe('ConnectorStatusWord', () => {
  test('a connector that needs an account says so in visible text', () => {
    const html = renderToStaticMarkup(<ConnectorStatusWord connector={connector({ status: 'needs_account' } as Partial<AdminConnector>)} accountCount={0} />);
    expect(visibleText(html)).toBe('· Needs account');
    expect(html).not.toContain('sr-only');
  });

  test('an HTTP connector without routes says No tools', () => {
    const html = renderToStaticMarkup(<ConnectorStatusWord connector={connector({ provider: 'http', actions: [] } as Partial<AdminConnector>)} />);
    expect(visibleText(html)).toBe('· No tools');
  });

  test('a healthy connector renders no word', () => {
    const html = renderToStaticMarkup(<ConnectorStatusWord connector={connector({ provider: 'http' } as Partial<AdminConnector>)} />);
    expect(html).toBe('');
  });
});

describe('ConnectorStatusLogo', () => {
  test('a problem state is not hidden in screen-reader-only text: the subtitle word carries it', () => {
    const html = renderToStaticMarkup(
      <ConnectorStatusLogo
        connector={connector({ provider: 'http', actions: [] } as Partial<AdminConnector>)}
        source={{ kind: 'initials', name: 'mobbin' } as never}
      />,
    );
    expect(html).not.toContain('No tools');
    expect(html).toContain('bg-kortix-orange');
  });
});
