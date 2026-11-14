import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * KRTX-4799: the workspace Inbox page is the workspace's Review queue, under
 * its own title. The person's notifications — user-global, every workspace —
 * are not a sibling view of it, so the page renders no tab strip.
 */

const reviewProps: Array<{ projectId: string }> = [];
mock.module('../../customize/sections/view/review-view', () => ({
  ReviewView: (props: { projectId: string }) => {
    reviewProps.push(props);
    return createElement('div', { 'data-testid': 'review-view-stub' });
  },
}));
mock.module('../../i18n', () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}));
mock.module('../../internal/layout/project-page-header', () => ({
  ProjectPageHeader: (props: { title: string }) => createElement('h1', null, props.title),
}));

const { WorkspaceInbox } = await import('./workspace-inbox');

describe('WorkspaceInbox', () => {
  test('the page is the workspace Review queue: the Review title over the Review list', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceInbox, { projectId: 'p1' }));
    expect(html).toContain('>sidebar.spaces.review<');
    expect(reviewProps).toEqual([{ projectId: 'p1' }]);
  });

  test('notifications are not a view here: no tab strip, no inbox key', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceInbox, { projectId: 'p1' }));
    expect(html).not.toContain('role="tab"');
    expect(html).not.toContain('inbox.');
    expect(html).not.toContain('notifications.inbox');
  });
});
