import { describe, expect, test } from 'bun:test';

import { publicGatewayBaseUrl } from './public-url';

describe('publicGatewayBaseUrl', () => {
  test('derives the public origin from the configured base url', () => {
    expect(publicGatewayBaseUrl('https://gateway-dev.dosco.live/v1/llm')).toBe(
      'https://gateway-dev.dosco.live',
    );
    expect(publicGatewayBaseUrl('https://gateway.dosco.live/v1/llm')).toBe(
      'https://gateway.dosco.live',
    );
  });

  test('returns null when unset or malformed', () => {
    expect(publicGatewayBaseUrl(undefined)).toBeNull();
    expect(publicGatewayBaseUrl(null)).toBeNull();
    expect(publicGatewayBaseUrl('')).toBeNull();
    expect(publicGatewayBaseUrl('not a url')).toBeNull();
  });
});
