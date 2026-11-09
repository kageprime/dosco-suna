/**
 * KRTX-4465 (Strix CWE-367 follow-up): deleteSandboxImage's `snapshotName`
 * option deletes the EXACT provider identity a caller hands it and never
 * re-derives it from a slug. The session heal uses this: a project template
 * named `default-warm` that disappears mid-provision must not re-resolve to
 * the shared platform default and make the heal delete the image every
 * tenant's next session boots from.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const deletedNames: string[] = [];
const resolvedSlugs: Array<string | undefined> = [];

mock.module('./providers', () => ({
  getSandboxProvider: (id?: string) => {
    if (!id) throw new Error('no provider resolved');
    return {
      getSnapshotState: async () => 'active',
      deleteSnapshot: async (name: string) => {
        deletedNames.push(name);
      },
    };
  },
}));

// Spread the real module (every export the graph binds stays) and override
// the resolve with the spy: any slug resolution at all in the snapshotName
// path is the defect this pins against.
const actualTemplates = await import('./templates');
mock.module('./templates', () => ({
  ...actualTemplates,
  resolveTemplateForBuildSlug: async (_project: unknown, slug?: string) => {
    resolvedSlugs.push(slug);
    return resolvedTemplate();
  },
  refreshTemplateState: async () => {},
}));

function resolvedTemplate() {
  return {
    templateId: 'tpl-resolved',
    projectId: 'proj_resolved',
    slug: 'default',
    name: 'Platform default',
    isShared: true,
    source: 'platform' as const,
    provider: 'platinum',
    image: null,
    dockerfilePath: null,
    entrypoint: null,
    cpu: 2,
    memoryGb: 4,
    diskGb: 10,
    containerRuntime: false,
    residentialProxy: null,
    providerState: 'active',
    providerSnapshotName: null,
    contentHash: null,
    builtFromCommit: null,
    swapKey: null,
    lastReady: {},
  };
}

const { deleteSandboxImage } = await import('./template-prebuilds');

const project = { projectId: 'proj_heal', repoUrl: '', defaultBranch: 'main', manifestPath: 'kortix.yaml' };

describe('deleteSandboxImage with an explicit snapshotName (the session heal path)', () => {
  beforeEach(() => {
    deletedNames.length = 0;
    resolvedSlugs.length = 0;
  });

  test('deletes exactly the given name and never resolves a slug', async () => {
    const out = await deleteSandboxImage(project, {
      snapshotName: 'kortix-tpl-boooted-identity',
      provider: 'platinum',
      slug: 'default-warm',
    });
    expect(deletedNames).toEqual(['kortix-tpl-boooted-identity']);
    expect(resolvedSlugs).toEqual([]);
    expect(out).toEqual({ deleted: true, snapshotName: 'kortix-tpl-boooted-identity', slug: 'default-warm' });
  });

  test('the slug path still resolves as before (no behavior change for the other callers)', async () => {
    await deleteSandboxImage(project, { slug: 'default-warm', provider: 'platinum' });
    expect(resolvedSlugs).toEqual(['default-warm']);
    expect(deletedNames).toHaveLength(1);
    // The resolved template is the shared default → the platform prefix.
    expect(deletedNames[0]).toStartWith('kortix-default-');
  });
});
