import { describe, expect, test } from 'bun:test';

import { notificationsRedirectTarget } from './notifications-redirect';

describe('notificationsRedirectTarget — the old Notifications-tab bookmark (KRTX-4799)', () => {
  test('?view=notifications moves to the person\'s Inbox page, outside the workspace', () => {
    expect(notificationsRedirectTarget('notifications')).toBe('/inbox');
  });

  test('every other address stays on the workspace Review queue', () => {
    expect(notificationsRedirectTarget('review')).toBeNull();
    expect(notificationsRedirectTarget('')).toBeNull();
    expect(notificationsRedirectTarget(null)).toBeNull();
    expect(notificationsRedirectTarget(undefined)).toBeNull();
  });
});
