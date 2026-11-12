/**
 * Name a signed-in device from the User-Agent it signed in with: "Chrome" on
 * "macOS". First match wins, so the browsers that also claim "Chrome" or
 * "Safari" in their UA come first. A UA that is not a browser (a script, the
 * CLI) keeps its product token ("Bun"); the generic `Mozilla/` token names
 * nothing. An empty UA names nothing and the row falls back to "Unknown device".
 *
 * `brand` picks the corner logo: the browser's mark when it has one, else the
 * system's (ChromeOS shares the Chrome mark), else none.
 */
export type DeviceBrand = 'chrome' | 'safari' | 'firefox' | 'edge' | 'linux' | 'bun';

const BRAND_OF: Record<string, DeviceBrand> = {
  Chrome: 'chrome',
  Safari: 'safari',
  Firefox: 'firefox',
  Edge: 'edge',
  Linux: 'linux',
  Bun: 'bun',
  ChromeOS: 'chrome',
};

const BROWSERS: [RegExp, string][] = [
  [/Electron\//, 'Dosco desktop'],
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/(Firefox|FxiOS)\//, 'Firefox'],
  [/(Chrome|CriOS)\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPod/, 'iOS'],
  [/iPad/, 'iPadOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Windows/, 'Windows'],
  [/Linux/, 'Linux'],
];

export function describeUserAgent(userAgent: string | null): {
  browser: string | null;
  os: string | null;
  mobile: boolean;
  brand: DeviceBrand | null;
} {
  const ua = userAgent ?? '';
  const token = /^([\w.-]+)\//.exec(ua)?.[1];
  const browser =
    BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ??
    (token && token !== 'Mozilla' ? token : null);
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const brand = (browser && BRAND_OF[browser]) || (os && BRAND_OF[os]) || null;
  return { browser, os, mobile: os === 'iOS' || os === 'Android', brand };
}

/**
 * The device-row label: "<browser> on <os>" when the UA names both, the one it
 * names alone, else "Unknown device". One rule for every caller: the settings
 * container passes its translator, fixtures that render without a locale use
 * the English default below.
 */
export function deviceLabel(
  { browser, os }: { browser: string | null; os: string | null },
  t: (
    key: 'deviceName' | 'unknownDevice',
    values?: { browser: string; os: string },
  ) => string = (key, values) =>
    key === 'deviceName' && values ? `${values.browser} on ${values.os}` : 'Unknown device',
): string {
  return browser && os ? t('deviceName', { browser, os }) : (browser ?? os ?? t('unknownDevice'));
}
