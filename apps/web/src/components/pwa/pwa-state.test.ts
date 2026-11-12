import { describe, expect, test } from 'bun:test';

import {
  INSTALL_DISMISSED_KEY,
  IOS_HINT_DISMISSED_KEY,
  dismiss,
  dismissed,
  isIosWithoutInstallPrompt,
  isStandalone,
  offersInstallCard,
} from './pwa-state';

const storage = (values: Record<string, string> = {}) => ({
  getItem: (key: string) => values[key] ?? null,
  setItem: (key: string, value: string) => {
    values[key] = value;
  },
});

describe('isStandalone', () => {
  test('true when Chromium reports the standalone display mode', () => {
    expect(isStandalone(true, false)).toBe(true);
  });

  test('true on iOS, whose only signal is the navigator.standalone flag', () => {
    expect(isStandalone(false, true)).toBe(true);
  });

  test('false in a browser tab', () => {
    expect(isStandalone(false, false)).toBe(false);
  });
});

describe('isIosWithoutInstallPrompt', () => {
  test('an iPhone user agent', () => {
    expect(isIosWithoutInstallPrompt('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, false)).toBe(true);
  });

  test('an iPad user agent', () => {
    expect(isIosWithoutInstallPrompt('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', 5, false)).toBe(true);
  });

  test('iPadOS 13+, which reports as a Mac with touch points', () => {
    expect(isIosWithoutInstallPrompt('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5, false)).toBe(true);
  });

  test('a Mac without touch points stays a desktop', () => {
    expect(isIosWithoutInstallPrompt('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0, false)).toBe(false);
  });

  test('an installed iOS app never shows the hint again', () => {
    expect(isIosWithoutInstallPrompt('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5, true)).toBe(false);
  });
});

describe('dismissed / dismiss', () => {
  test('a stored dismissal reads back', () => {
    const store = storage({ [INSTALL_DISMISSED_KEY]: '1' });
    expect(dismissed(store, INSTALL_DISMISSED_KEY)).toBe(true);
    dismiss(store, IOS_HINT_DISMISSED_KEY);
    expect(dismissed(store, IOS_HINT_DISMISSED_KEY)).toBe(true);
  });

  test('an unreadable storage reads as never dismissed, and a throw on write is silent', () => {
    const throwing = {
      getItem: () => {
        throw new Error('private mode');
      },
      setItem: () => {
        throw new Error('private mode');
      },
    };
    expect(dismissed(throwing, INSTALL_DISMISSED_KEY)).toBe(false);
    expect(() => dismiss(throwing, INSTALL_DISMISSED_KEY)).not.toThrow();
  });
});

describe('offersInstallCard', () => {
  test('a touch-first device (phone, tablet) gets the floating install card', () => {
    expect(offersInstallCard(true)).toBe(true);
  });

  test('a desktop with a mouse never gets it: the card covered app controls, and the address bar has its own Install button', () => {
    expect(offersInstallCard(false)).toBe(false);
  });
});
