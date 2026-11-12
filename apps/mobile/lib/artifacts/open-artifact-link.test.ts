import { afterEach, describe, expect, test } from 'bun:test';

import { useArtifactViewerStore } from '@/stores/artifact-viewer-store';
import { openArtifactLink } from './open-artifact-link';

const PROJECT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const ARTIFACT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

afterEach(() => useArtifactViewerStore.setState({ projectId: null, target: null }));

describe('openArtifactLink', () => {
  test('an artifact of the project on screen opens in the viewer', () => {
    useArtifactViewerStore.getState().setProjectId(PROJECT);
    expect(openArtifactLink(`https://kortix.com/workspaces/${PROJECT}/artifacts/${ARTIFACT}`, 'Q3 deck')).toBe(true);
    expect(useArtifactViewerStore.getState().target).toEqual({ projectId: PROJECT, artifactId: ARTIFACT, title: 'Q3 deck' });
  });
  test('outside a project, nothing opens', () => {
    expect(openArtifactLink(`https://kortix.com/workspaces/${PROJECT}/artifacts/${ARTIFACT}`)).toBe(false);
    expect(useArtifactViewerStore.getState().target).toBeNull();
  });
  test('another project, a public link, or a website keep the browser path', () => {
    useArtifactViewerStore.getState().setProjectId(PROJECT);
    expect(openArtifactLink(`https://kortix.com/workspaces/${OTHER}/artifacts/${ARTIFACT}`)).toBe(false);
    expect(openArtifactLink(`https://kortix.com/share/artifact/${ARTIFACT}`)).toBe(false);
    expect(openArtifactLink('https://example.com/')).toBe(false);
    expect(useArtifactViewerStore.getState().target).toBeNull();
  });
});
