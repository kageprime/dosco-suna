import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMobileRegistrationUrl,
  isMobileAuthCallbackUrl,
} from './web-registration-handoff.ts';

test('buildMobileRegistrationUrl carries the native callback state to web auth', () => {
  assert.equal(
    buildMobileRegistrationUrl('https://dosco.live/', 'native-state'),
    'https://dosco.live/auth?mobile_callback=1&state=native-state',
  );
});

test('isMobileAuthCallbackUrl accepts the custom scheme callback', () => {
  assert.equal(
    isMobileAuthCallbackUrl('dosco://auth/callback?state=native-state'),
    true,
  );
});

test('isMobileAuthCallbackUrl accepts only opted-in Dosco HTTPS callbacks', () => {
  assert.equal(
    isMobileAuthCallbackUrl('https://dosco.live/auth/callback?mobile_callback=1&state=native-state'),
    true,
  );
  assert.equal(
    isMobileAuthCallbackUrl('https://evil.example/auth/callback?mobile_callback=1&state=native-state'),
    false,
  );
  assert.equal(
    isMobileAuthCallbackUrl('https://dosco.live/auth/callback?state=native-state'),
    false,
  );
});

test('buildMobileRegistrationUrl carries an SSO email after the state', () => {
  assert.equal(
    buildMobileRegistrationUrl('https://kortix.example/', 's1', 'user@example.test'),
    'https://kortix.example/auth?mobile_callback=1&state=s1&email=user%40example.test&sso=1',
  );
});
