import { describe, expect, test } from 'bun:test';
import type { ProjectManifestHealth } from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import messages from '../../../../../../apps/web/translations/en.json';
import { IntlTestProvider as NextIntlClientProvider } from '../../../test-utils/intl';
import { ManifestIssuesRowView } from './manifest-issues-row';

const WARNING: ProjectManifestHealth = {
  path: 'kortix.yaml',
  state: 'issues',
  errors: 0,
  warnings: 1,
  issues: [
    {
      path: 'apps.sample.monthly_budget_usd',
      message: 'is retired and ignored: Apps have no budget. Remove it.',
      severity: 'warning',
      line: 96,
      column: 5,
    },
  ],
};

function render(health: ProjectManifestHealth | undefined, myKortix = true) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ sidebar: messages.sidebar }} timeZone="UTC" onError={() => {}}>
      <ManifestIssuesRowView health={health} myKortix={myKortix} pending={false} onFix={() => {}} />
    </NextIntlClientProvider>,
  );
}

describe('Git tab: the manifest row shows the open issues', () => {
  test('state=issues: the count, each issue with its location and key, and the Fix action', () => {
    const html = render(WARNING);
    expect(html).toContain('1 warning');
    expect(html).toContain('kortix.yaml:96:5');
    expect(html).toContain('apps.sample.monthly_budget_usd');
    expect(html).toContain('is retired and ignored');
    expect(html).toContain('Everything still runs.');
    expect(html).toContain('Fix with My Kortix');
    // Warnings only: a calm, neutral mark, not the warning colour.
    expect(html).not.toContain('text-kortix-orange');
  });

  test('with errors the count names both and the mark takes the warning colour', () => {
    const html = render({
      ...WARNING,
      errors: 1,
      warnings: 1,
      issues: [...WARNING.issues, { path: 'agents.helper.modle', message: 'Unknown key.', severity: 'error', line: 4, column: 5 }],
    });
    expect(html).toContain('1 error and 1 warning');
    expect(html).toContain('text-kortix-orange');
  });

  test('a project without My Kortix gets the generic fix', () => {
    expect(render(WARNING, false)).toContain('Fix in a new session');
  });

  test('state=ok, an unread manifest, or only fix-able warnings render nothing', () => {
    expect(render({ path: 'kortix.yaml', state: 'ok', errors: 0, warnings: 0, issues: [] })).toBe('');
    expect(render(undefined)).toBe('');
    expect(render({ ...WARNING, issues: [{ ...WARNING.issues[0]!, fix: 'drop-app-budget' }] })).toBe('');
  });
});
