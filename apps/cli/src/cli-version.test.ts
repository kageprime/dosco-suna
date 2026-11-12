import { describe, expect, test } from 'bun:test';
import { resolveCliVersion } from './cli-version.ts';

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('resolveCliVersion', () => {
  test('a staging stamp of the release commit reports the release', () => {
    const env = { KORTIX_RELEASE_VERSION: '0.15.6', KORTIX_RELEASE_COMMIT: COMMIT };
    expect(resolveCliVersion('0.15.6-staging.a1b2c3d4+a1b2c3d4', env)).toBe('0.15.6+a1b2c3d4');
    expect(resolveCliVersion('0.15.5-staging.a1b2c3d4', env)).toBe('0.15.6+a1b2c3d4');
  });

  test('a different commit keeps the baked version', () => {
    const env = { KORTIX_RELEASE_VERSION: '0.15.6', KORTIX_RELEASE_COMMIT: COMMIT };
    expect(resolveCliVersion('0.15.6-staging.deadbeef+deadbeef', env)).toBe('0.15.6-staging.deadbeef+deadbeef');
  });

  test('no release, or a release that is not X.Y.Z, keeps the baked version', () => {
    expect(resolveCliVersion('0.15.6-staging.a1b2c3d4+a1b2c3d4', {})).toBe('0.15.6-staging.a1b2c3d4+a1b2c3d4');
    const staging = { KORTIX_RELEASE_VERSION: '0.15.6-staging.a1b2c3d4', KORTIX_RELEASE_COMMIT: COMMIT };
    expect(resolveCliVersion('0.15.6-staging.a1b2c3d4+a1b2c3d4', staging)).toBe('0.15.6-staging.a1b2c3d4+a1b2c3d4');
  });

  test('a stamp without a commit keeps the baked version', () => {
    const env = { KORTIX_RELEASE_VERSION: '0.15.6', KORTIX_RELEASE_COMMIT: COMMIT };
    expect(resolveCliVersion('0.15.6', env)).toBe('0.15.6');
    expect(resolveCliVersion('dev', env)).toBe('dev');
  });
});
