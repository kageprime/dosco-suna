import { describe, expect, test } from 'bun:test';

import {
  artifactContentPrefix,
  artifactHttpErrorAction,
  artifactInProject,
  artifactShareUrl,
  artifactsEmptyState,
  decideArtifactNavigation,
} from './artifacts';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const ARTIFACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const VIEW = 'https://api.example.test/v1/artifacts/s/tOkEn.AbC-123/';
const PREFIX = 'https://api.example.test/v1/artifacts/s/tOkEn.AbC-123/';

describe('artifactContentPrefix', () => {
  test('a signed view URL is its own directory', () => {
    expect(artifactContentPrefix(VIEW)).toBe(PREFIX);
  });
  test('a page inside the directory resolves to the same directory', () => {
    expect(artifactContentPrefix(`${VIEW}slides/2.html?x=1`)).toBe(PREFIX);
  });
  test('a public content URL keeps its /p/<id>/ directory', () => {
    expect(artifactContentPrefix(`https://api.example.test/v1/artifacts/p/${ARTIFACT}/`)).toBe(
      `https://api.example.test/v1/artifacts/p/${ARTIFACT}/`,
    );
  });
  test('a token without the trailing slash still gets one', () => {
    expect(artifactContentPrefix('https://api.example.test/v1/artifacts/s/abc')).toBe(
      'https://api.example.test/v1/artifacts/s/abc/',
    );
  });
  test('any other URL is refused', () => {
    expect(artifactContentPrefix('https://evil.test/index.html')).toBeNull();
    expect(artifactContentPrefix('https://api.example.test/v1/artifacts/meta/abc')).toBeNull();
    expect(artifactContentPrefix('javascript:alert(1)')).toBeNull();
    expect(artifactContentPrefix('not a url')).toBeNull();
  });
});

describe('decideArtifactNavigation', () => {
  test('pages and assets inside the artifact load in the viewer', () => {
    expect(decideArtifactNavigation(VIEW, PREFIX)).toBe('allow');
    expect(decideArtifactNavigation(`${VIEW}page-2.html`, PREFIX)).toBe('allow');
    expect(decideArtifactNavigation(`${VIEW}#section`, PREFIX)).toBe('allow');
  });
  test('the scheme and host compare case-insensitively, the token exactly', () => {
    expect(decideArtifactNavigation('HTTPS://API.EXAMPLE.TEST/v1/artifacts/s/tOkEn.AbC-123/a', PREFIX)).toBe('allow');
    expect(decideArtifactNavigation('https://api.example.test/v1/artifacts/s/token.abc-123/a', PREFIX)).toBe(
      'open-external',
    );
  });
  test('another artifact or the API itself is not inside this artifact', () => {
    expect(decideArtifactNavigation('https://api.example.test/v1/artifacts/s/other/', PREFIX)).toBe('open-external');
    expect(decideArtifactNavigation('https://api.example.test/v1/accounts', PREFIX)).toBe('open-external');
  });
  test('an outside top-frame link opens in the browser, on every platform', () => {
    expect(decideArtifactNavigation('https://example.com/docs', PREFIX)).toBe('open-external');
    expect(decideArtifactNavigation('https://example.com/docs', PREFIX, { isTopFrame: true })).toBe('open-external');
    expect(decideArtifactNavigation('mailto:team@example.com', PREFIX)).toBe('open-external');
  });
  test('an embedded frame from another origin loads inside the page', () => {
    expect(decideArtifactNavigation('https://www.youtube.com/embed/x', PREFIX, { isTopFrame: false })).toBe('allow');
  });
  test('inline documents load', () => {
    expect(decideArtifactNavigation('about:blank', PREFIX)).toBe('allow');
    expect(decideArtifactNavigation('data:text/html,hi', PREFIX)).toBe('allow');
    expect(decideArtifactNavigation('blob:https://x/1', PREFIX)).toBe('allow');
  });
  test('every other scheme is blocked', () => {
    expect(decideArtifactNavigation('javascript:alert(1)', PREFIX)).toBe('block');
    expect(decideArtifactNavigation('intent://scan#Intent;end', PREFIX)).toBe('block');
    expect(decideArtifactNavigation('kortix://projects/x', PREFIX)).toBe('block');
    expect(decideArtifactNavigation('file:///etc/hosts', PREFIX)).toBe('block');
    expect(decideArtifactNavigation('tel:+15550100', PREFIX)).toBe('block');
  });
});

describe('artifactShareUrl', () => {
  const base = { web_url: 'https://app.test/workspaces/p/artifacts/a', public_url: 'https://app.test/share/artifact/a' };
  test('a public artifact shares its public page', () => {
    expect(artifactShareUrl({ ...base, visibility: 'public' })).toBe(base.public_url);
  });
  test('a private or project artifact shares the app link', () => {
    expect(artifactShareUrl({ ...base, visibility: 'private' })).toBe(base.web_url);
    expect(artifactShareUrl({ ...base, visibility: 'project' })).toBe(base.web_url);
  });
  test('a public artifact without a public URL falls back to the app link', () => {
    expect(artifactShareUrl({ ...base, visibility: 'public', public_url: null })).toBe(base.web_url);
  });
});

describe('artifactInProject', () => {
  test('an app link into this project names the artifact', () => {
    expect(artifactInProject(`https://app.test/workspaces/${PROJECT}/artifacts/${ARTIFACT}`, PROJECT)).toBe(ARTIFACT);
    expect(artifactInProject(`https://app.test/en/projects/${PROJECT}/artifacts/${ARTIFACT}/`, PROJECT)).toBe(ARTIFACT);
    expect(artifactInProject(`/workspaces/${PROJECT}/artifacts/${ARTIFACT}`, PROJECT)).toBe(ARTIFACT);
  });
  test('ids compare case-insensitively', () => {
    expect(
      artifactInProject(`https://app.test/workspaces/${PROJECT.toUpperCase()}/artifacts/${ARTIFACT}`, PROJECT.toUpperCase()),
    ).toBe(ARTIFACT);
  });
  test('another project, a public link, or a website keep the browser path', () => {
    const other = '99999999-2222-4333-8444-555555555555';
    expect(artifactInProject(`https://app.test/workspaces/${other}/artifacts/${ARTIFACT}`, PROJECT)).toBeNull();
    expect(artifactInProject(`https://app.test/share/artifact/${ARTIFACT}`, PROJECT)).toBeNull();
    expect(artifactInProject('https://example.com/report', PROJECT)).toBeNull();
    expect(artifactInProject('', PROJECT)).toBeNull();
    expect(artifactInProject(`https://app.test/workspaces/${PROJECT}/artifacts/${ARTIFACT}`, null)).toBeNull();
  });
});

describe('artifactsEmptyState', () => {
  test('a search with no match says so', () => {
    expect(artifactsEmptyState({ query: 'deck', scope: 'all' })).toBe('no-match');
    expect(artifactsEmptyState({ query: 'deck', scope: 'pinned' })).toBe('no-match');
  });
  test('no artifacts at all', () => {
    expect(artifactsEmptyState({ query: '  ', scope: 'all' })).toBe('none');
  });
  test('an empty scope', () => {
    expect(artifactsEmptyState({ query: '', scope: 'pinned' })).toBe('scope-empty');
  });
});

describe('artifactHttpErrorAction', () => {
  test('an expired or refused signed URL reads the artifact again once', () => {
    expect(artifactHttpErrorAction(403, false)).toBe('refresh');
    expect(artifactHttpErrorAction(404, false)).toBe('refresh');
    expect(artifactHttpErrorAction(410, false)).toBe('refresh');
  });
  test('a second failure, or a server error, shows the error', () => {
    expect(artifactHttpErrorAction(403, true)).toBe('error');
    expect(artifactHttpErrorAction(500, false)).toBe('error');
  });
});
