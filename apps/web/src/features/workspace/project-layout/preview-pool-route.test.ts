import { describe, expect, test } from 'bun:test';

import { previewPoolAllowed } from './preview-pool-route';

describe('previewPoolAllowed', () => {
  test('a settings route does not start the preview pool', () => {
    for (const path of [
      '/workspaces/p1/admin',
      '/workspaces/p1/admin/roles',
      '/workspaces/p1/admin/members',
      '/workspaces/p1/admin/connectors/github/main',
      '/en/workspaces/p1/admin/plan',
      '/workspaces/p1/settings/general',
      '/workspaces/p1/customize',
      '/workspaces/p1/members',
    ]) {
      expect(previewPoolAllowed(path)).toBe(false);
    }
  });

  test('a content route starts it', () => {
    for (const path of [
      '/workspaces/p1',
      '/workspaces/p1/apps',
      '/workspaces/p1/artifacts/a1',
      '/workspaces/p1/sessions/s1',
      '/de/workspaces/p1/drive',
      '/workspaces/p1/spaces/home',
    ]) {
      expect(previewPoolAllowed(path)).toBe(true);
    }
  });

  test('no pathname, or a route outside a project, starts nothing', () => {
    expect(previewPoolAllowed(null)).toBe(false);
    expect(previewPoolAllowed('/workspaces')).toBe(false);
    expect(previewPoolAllowed('/dashboard')).toBe(false);
  });
});
