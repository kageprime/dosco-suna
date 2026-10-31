import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { CodePanel as SecurityPagePanel } from './security-page/code-panel';

const YAML_LINES = [
  '# reads run; writes and destructive calls stop for a human',
  'policy:',
  '  default_mode: risk',
  '',
  'policies:',
  '  # a name-only rule cannot gate the target — conditions can',
  '  - match: gmail.send_email',
  '    action: require_approval',
] as const;

const VALUE = 'text-muted-foreground';

const PANELS = [
  ['security-page', SecurityPagePanel],
] as const;

describe('the marketing code panel rendering', () => {
  test('renders a non-snippet line in the plain value color', () => {
    for (const [page, Panel] of PANELS) {
      const yaml = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="yaml" />);
      expect(yaml).toContain(`<span class="${VALUE}">plain text</span>`);
      const sh = renderToStaticMarkup(<Panel title="t" lines={['plain text']} lang="sh" />);
      expect(sh).toContain(`<span class="${VALUE}">plain text</span>`);
    }
  });

  test('appends the caller className to the panel frame', () => {
    for (const [page, Panel] of PANELS) {
      const html = renderToStaticMarkup(
        <Panel title="t" lines={YAML_LINES} lang="yaml" className="min-w-0" />,
      );
      expect(html).toContain('rounded-sm border min-w-0"');
    }
  });
});
