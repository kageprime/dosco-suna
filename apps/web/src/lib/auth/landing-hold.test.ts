/**
 * The landing route's paint hold (`landing-auth-gate.tsx` renders the
 * decision; the root layout's head runs the script). The script string is
 * built from these pieces and ships in the static HTML of every page, so both
 * the cookie pattern and the generated script are pinned here.
 */
import { describe, expect, test } from 'bun:test';

import {
  LANDING_HOLD_ATTRIBUTE,
  LANDING_HOLD_COOKIE_PATTERN,
  LANDING_HOLD_SCRIPT,
} from './landing-hold';

describe('LANDING_HOLD_COOKIE_PATTERN', () => {
  test('matches the session cookie, its chunks, and the local-dev port name', () => {
    expect(LANDING_HOLD_COOKIE_PATTERN.test('sb-kortix-auth-token=abc')).toBe(true);
    expect(LANDING_HOLD_COOKIE_PATTERN.test('sb-kortix-auth-token.0=abc; other=x')).toBe(true);
    expect(LANDING_HOLD_COOKIE_PATTERN.test('a=b; sb-kortix-auth-token-3000=abc')).toBe(true);
    expect(LANDING_HOLD_COOKIE_PATTERN.test('sb-kortix-auth-token-3000.1=abc')).toBe(true);
  });

  test('never matches a foreign cookie or a name that only prefixes ours', () => {
    expect(LANDING_HOLD_COOKIE_PATTERN.test('kortix_last_project=x:y')).toBe(false);
    expect(LANDING_HOLD_COOKIE_PATTERN.test('xsb-kortix-auth-token=abc')).toBe(false);
    expect(LANDING_HOLD_COOKIE_PATTERN.test('')).toBe(false);
  });
});

describe('LANDING_HOLD_SCRIPT', () => {
  test('checks the landing roots and the session cookie, and sets the hold attribute', () => {
    // The landing roots: `/` and every locale root, with or without a slash.
    expect('/'.match(rootOf(LANDING_HOLD_SCRIPT))).not.toBeNull();
    expect('/en'.match(rootOf(LANDING_HOLD_SCRIPT))).not.toBeNull();
    expect('/sr/'.match(rootOf(LANDING_HOLD_SCRIPT))).not.toBeNull();
    expect('/pricing'.match(rootOf(LANDING_HOLD_SCRIPT))).toBeNull();
    expect('/workspaces'.match(rootOf(LANDING_HOLD_SCRIPT))).toBeNull();
    expect('/en/pricing'.match(rootOf(LANDING_HOLD_SCRIPT))).toBeNull();

    // The cookie family and the attribute it flips must both appear verbatim,
    // and the whole thing must be one self-contained IIFE.
    expect(LANDING_HOLD_SCRIPT).toContain(LANDING_HOLD_COOKIE_PATTERN.source);
    expect(LANDING_HOLD_SCRIPT).toContain(LANDING_HOLD_ATTRIBUTE);
    expect(LANDING_HOLD_SCRIPT.startsWith('(function(){')).toBe(true);
    expect(LANDING_HOLD_SCRIPT.endsWith('})();')).toBe(true);
  });
});

/** The pathname regex embedded in the generated script, lifted back out. */
function rootOf(script: string): RegExp {
  const match = script.match(/new RegExp\("([^"]+)"\)/);
  if (!match) throw new Error('no pathname RegExp in the generated script');
  return new RegExp(match[1]);
}
