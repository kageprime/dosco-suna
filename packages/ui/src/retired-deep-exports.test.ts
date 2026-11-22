import { expect, test } from 'bun:test';

for (const subpath of [
  'workspace/sidebar/project-nav-items',
  'session/models/connect-model-step',
  'session/models/use-workspace-model-gate',
]) {
  test(`unused deep implementation ${subpath} is not a public entry`, () => {
    expect(() => import.meta.resolve(`@kortix/ui/${subpath}`)).toThrow();
  });
}
