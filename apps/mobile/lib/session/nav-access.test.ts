import { describe, expect, test } from 'bun:test';
import { NAV_ACTIONS, REVIEW_ACCESS, appsRowVisible, artifactsRowVisible, navAccessAllowed } from './nav-access';

const cans = (allowed: string[], loading = false) =>
  new Proxy({} as Record<string, { allowed: boolean; isLoading: boolean }>, {
    get: (_, action: string) => ({ allowed: allowed.includes(action), isLoading: loading }),
  });

describe('navAccessAllowed', () => {
  test('Review needs read AND act', () => {
    expect(navAccessAllowed(cans(['project.review.read']), REVIEW_ACCESS)).toBe(false);
    expect(navAccessAllowed(cans(['project.review.read', 'project.review.act']), REVIEW_ACCESS)).toBe(true);
  });
  test('nothing shows before the verdict lands', () => {
    expect(navAccessAllowed(cans(['project.review.read', 'project.review.act'], true), REVIEW_ACCESS)).toBe(false);
    expect(navAccessAllowed({}, REVIEW_ACCESS)).toBe(false);
  });
});

describe('appsRowVisible', () => {
  test('deploy leaf shows the row', () => expect(appsRowVisible(cans(['project.app.deploy']), 0)).toBe(true));
  test('without deploy, an existing App shows it', () => {
    expect(appsRowVisible(cans([]), 1)).toBe(true);
    expect(appsRowVisible(cans([]), 0)).toBe(false);
    expect(appsRowVisible(cans([]), undefined)).toBe(false);
  });
  test('hidden while the verdict loads', () => expect(appsRowVisible(cans([], true), 3)).toBe(false));
});

describe('artifactsRowVisible', () => {
  test('a Drive and the read leaf show the row', () => {
    expect(artifactsRowVisible(cans(['project.artifact.read']), true)).toBe(true);
  });
  test('no Drive on the platform hides it, whatever the leaf', () => {
    expect(artifactsRowVisible(cans(['project.artifact.read']), false)).toBe(false);
  });
  test('without the read leaf, or before the verdict, it stays hidden', () => {
    expect(artifactsRowVisible(cans([]), true)).toBe(false);
    expect(artifactsRowVisible(cans(['project.artifact.read'], true), true)).toBe(false);
    expect(artifactsRowVisible({}, true)).toBe(false);
  });
  test('the drawer batch asks for the read leaf', () => {
    expect(NAV_ACTIONS).toContain('project.artifact.read');
  });
});
