/**
 * Waits for the user to come back from the in-app browser.
 *
 * `WebBrowser.openBrowserAsync` resolves when the browser CLOSES on iOS, but
 * on Android it resolves `{ type: 'opened' }` the moment the Custom Tab
 * launches (expo-web-browser `WebBrowserModule.kt`). Work that must run after
 * the trip — a refetch, a "connected" toast — therefore also waits for the app
 * to leave the foreground and return to `active`. Pure (the AppState
 * subscription is injected) so `bun test` covers it; `open-browser.ts` wires
 * the real AppState.
 */
export type AppStateSubscribe = (listener: (state: string) => void) => { remove: () => void };

/** `cancel` removes the listener; the promise then never resolves. */
export function waitForForegroundReturn(subscribe: AppStateSubscribe): {
  returned: Promise<void>;
  cancel: () => void;
} {
  let cancel = () => {};
  const returned = new Promise<void>((resolve) => {
    let left = false;
    const subscription = subscribe((state) => {
      if (state !== 'active') {
        left = true;
        return;
      }
      if (!left) return;
      subscription.remove();
      resolve();
    });
    cancel = () => subscription.remove();
  });
  return { returned, cancel };
}

/** The bare app URL, `kortix://`: the iOS Smart App Banner's OPEN. */
export function isAppOpenUrl(url: string): boolean {
  return /^kortix:\/\/\/?$/i.test(url.trim());
}

type InAppBrowser = {
  dismissAuthSession: () => void;
  dismissBrowser: () => Promise<unknown>;
};

/**
 * The iOS Smart App Banner on kortix.com opens the bare app URL, `kortix://`
 * (`app-argument`, apps/web `app/[locale]/layout.tsx`). The banner also shows
 * in this app's own in-app browser. Its OPEN then reaches the app that is
 * already running behind the browser, so nothing visible happened. This
 * closes that browser, so OPEN lands the user back in the app.
 * Returns `true` when `url` is the bare app URL: the caller handles nothing
 * else. iOS only: expo-web-browser has no dismiss on Android, and the banner
 * is iOS only.
 */
export function closeBrowserOnAppOpen(url: string, os: string, browser: InAppBrowser): boolean {
  if (!isAppOpenUrl(url)) return false;
  if (os === 'ios') {
    browser.dismissAuthSession();
    // Rejects with WebBrowserNotOpenException when no Safari View Controller is open.
    browser.dismissBrowser().catch(() => {});
  }
  return true;
}
