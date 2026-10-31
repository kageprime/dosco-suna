import { describe, expect, test } from 'bun:test';
import {
  PROVIDER_CONNECTED_URI,
  isBrowserReturnPath,
  projectModelsWebUrl,
} from './connect-model';

describe('projectModelsWebUrl', () => {
  test('builds the project customize/models URL', () => {
    expect(projectModelsWebUrl('https://dosco.live', 'proj-1')).toBe(
      'https://dosco.live/projects/proj-1/admin/models',
    );
  });

  test('trims a trailing slash off the frontend URL', () => {
    expect(projectModelsWebUrl('https://dosco.live/', 'proj-1')).toBe(
      'https://dosco.live/projects/proj-1/admin/models',
    );
  });

  test('encodes the project id', () => {
    expect(projectModelsWebUrl('https://dosco.live', 'proj 1/étage')).toBe(
      'https://dosco.live/projects/proj%201%2F%C3%A9tage/admin/models',
    );
  });
});

describe('projectModelsWebUrl with a return URL', () => {
  test('adds return_to, URL-encoded', () => {
    expect(projectModelsWebUrl('https://dosco.live', 'proj-1', PROVIDER_CONNECTED_URI)).toBe(
      'https://dosco.live/projects/proj-1/admin/models?return_to=kortix%3A%2F%2Fproviders%2Fconnected',
    );
  });
});

describe('isBrowserReturnPath', () => {
  test('matches the in-app browser return URLs, in every form the router sees', () => {
    expect(isBrowserReturnPath('dosco://providers/connected')).toBe(true);
    expect(isBrowserReturnPath('/providers/connected')).toBe(true);
    expect(isBrowserReturnPath('providers')).toBe(true);
    expect(isBrowserReturnPath('dosco://connectors/success?x=1')).toBe(true);
  });

  test('matches only the roots an in-app browser session returns to', () => {
    // No mobile code opens a browser session that returns to `dosco://connections`.
    expect(isBrowserReturnPath('dosco://connections/error')).toBe(false);
    expect(isBrowserReturnPath('/connections/success')).toBe(false);
  });

  test('leaves real routes alone', () => {
    expect(isBrowserReturnPath('/projects/p1')).toBe(false);
    expect(isBrowserReturnPath('dosco://auth/callback?code=1')).toBe(false);
    expect(isBrowserReturnPath('/providersfoo')).toBe(false);
    expect(isBrowserReturnPath('/')).toBe(false);
  });
});
