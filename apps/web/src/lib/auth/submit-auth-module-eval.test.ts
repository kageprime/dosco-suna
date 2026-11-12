// KRTX-4637: the /auth page's browser bundle evaluated this module on every
// page load, and its module-scope `new AuthApiError(...)` threw in a visitor's
// hardened environment — auth-js's constructor tag assignment failed on the
// frozen instance the environment's `super()` produced, with the exact prod
// signature `TypeError: Cannot add property __isAuthError, object is not
// extensible` (Better Stack pattern ccfd91c6, frame `new t` during module
// evaluation). One throwing constant took down the whole module, so the auth
// page lost its entire submit machinery, not just one error object.
//
// This file pins the boundary that matters: importing this module must not
// require constructing an auth error, even where every such construction
// throws. The module under test imports `AuthApiError` from
// '@supabase/supabase-js', so mocking that class is the environment boundary —
// the same technique the sibling suites use for their host modules.
import { expect, mock, test } from 'bun:test';

// The hostile environment, at the constructor: `super()` hands back a frozen
// instance, so auth-js's own `this.__isAuthError = true` throws (V8's exact
// prod message: "Cannot add property __isAuthError, object is not extensible").
mock.module('@supabase/supabase-js', () => ({
  AuthApiError: class AuthApiError extends Error {
    __isAuthError?: boolean;
    status?: number;
    code?: string;
    constructor(message: string, status?: number, code?: string) {
      super(message);
      Object.freeze(this);
      this.__isAuthError = true;
      this.name = 'AuthApiError';
      this.status = status;
      this.code = code;
    }
  },
}));

const { AuthApiError } = await import('@supabase/supabase-js');

test('the simulation reproduces the prod environment: constructing the error throws', () => {
  expect(() => new AuthApiError('x', 503, 'timeout')).toThrow(TypeError);
});

test('the module evaluates where auth-error construction throws', async () => {
  const mod = await import('./submit-auth');
  expect(typeof mod.submitAuthForm).toBe('function');
  expect(mod.AUTH_TIMEOUT_MESSAGE).toBe('This is taking longer than expected. Please try again.');
  expect(mod.AUTH_NETWORK_MESSAGE).toBe('The request could not be sent. Please try again.');
  expect(mod.AUTH_SUBMIT_TIMEOUT_MS).toBe(30_000);
});
