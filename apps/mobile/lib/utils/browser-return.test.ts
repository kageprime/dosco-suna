import { describe, expect, test } from 'bun:test';

import { redirectSystemPath } from '@/app/+native-intent';

import { closeBrowserOnAppOpen, waitForForegroundReturn, type AppStateSubscribe } from './browser-return';

function fakeAppState() {
  let listener: ((state: string) => void) | null = null;
  let removed = false;
  const subscribe: AppStateSubscribe = (fn) => {
    listener = fn;
    return { remove: () => { removed = true; listener = null; } };
  };
  return {
    subscribe,
    emit: (state: string) => listener?.(state),
    get removed() { return removed; },
  };
}

async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  promise.then(() => { done = true; });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe('waitForForegroundReturn', () => {
  test('resolves only after the app leaves the foreground and comes back', async () => {
    const app = fakeAppState();
    const wait = waitForForegroundReturn(app.subscribe).returned;
    expect(await settled(wait)).toBe(false);
    app.emit('background');
    expect(await settled(wait)).toBe(false);
    app.emit('active');
    expect(await settled(wait)).toBe(true);
    expect(app.removed).toBe(true);
  });

  test('an "active" event before the app ever left does not resolve it', async () => {
    const app = fakeAppState();
    const wait = waitForForegroundReturn(app.subscribe).returned;
    app.emit('active');
    expect(await settled(wait)).toBe(false);
    app.emit('inactive');
    app.emit('active');
    expect(await settled(wait)).toBe(true);
  });

  test('cancel removes the listener', () => {
    const app = fakeAppState();
    waitForForegroundReturn(app.subscribe).cancel();
    expect(app.removed).toBe(true);
  });
});

describe('closeBrowserOnAppOpen (iOS Smart App Banner OPEN)', () => {
  function fakeBrowser(open: boolean) {
    const calls: string[] = [];
    return {
      calls,
      dismissAuthSession: () => { calls.push('dismissAuthSession'); },
      // iOS rejects with WebBrowserNotOpenException when no browser is open.
      dismissBrowser: () => {
        calls.push('dismissBrowser');
        return open ? Promise.resolve({ type: 'dismiss' }) : Promise.reject(new Error('not open'));
      },
    };
  }

  test('the bare app URL closes the in-app browser on iOS', () => {
    for (const url of ['kortix://', 'kortix:///', ' KORTIX:// ']) {
      const browser = fakeBrowser(true);
      expect(closeBrowserOnAppOpen(url, 'ios', browser)).toBe(true);
      expect(browser.calls).toEqual(['dismissAuthSession', 'dismissBrowser']);
    }
  });

  test('no open browser is not an error', async () => {
    const browser = fakeBrowser(false);
    expect(closeBrowserOnAppOpen('kortix://', 'ios', browser)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(browser.calls).toEqual(['dismissAuthSession', 'dismissBrowser']);
  });

  test('Android has no dismiss API: handled, nothing called', () => {
    const browser = fakeBrowser(true);
    expect(closeBrowserOnAppOpen('kortix://', 'android', browser)).toBe(true);
    expect(browser.calls).toEqual([]);
  });

  test('every other link is left to its own handler and closes nothing', () => {
    for (const url of [
      'kortix://auth/callback?mobile_callback=1&state=s',
      'https://kortix.com/auth/callback?mobile_callback=1&state=s',
      'https://kortix.com/share/abc',
      'kortix://invites/00000000-0000-4000-8000-000000000000',
      'kortix://connectors',
      'kortix://connectors/done',
      'kortix://providers',
      'kortix://web',
      'https://kortix.com/',
    ]) {
      const browser = fakeBrowser(true);
      expect(closeBrowserOnAppOpen(url, 'ios', browser)).toBe(false);
      expect(browser.calls).toEqual([]);
    }
  });
});

describe('redirectSystemPath: the iOS Smart App Banner OPEN (kortix://)', () => {
  test('a warm open keeps the current screen; a cold start begins at the splash', () => {
    expect(redirectSystemPath({ path: 'kortix://', initial: false })).toBeNull();
    expect(redirectSystemPath({ path: 'kortix://', initial: true })).toBe('/');
  });
});
