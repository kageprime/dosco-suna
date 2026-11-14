/**
 * Runs `fn` with the global `URLSearchParams` of the mobile app: it installs
 * `react-native-url-polyfill` (whatwg-url-without-unicode 8), whose
 * `URLSearchParams` has no `size`. A query built with it must still reach the
 * URL (KRTX-4898).
 */
export async function withSizelessURLSearchParams<T>(fn: () => Promise<T>): Promise<T> {
  const native = globalThis.URLSearchParams;
  class Sizeless extends native {}
  Object.defineProperty(Sizeless.prototype, 'size', { get: () => undefined });
  globalThis.URLSearchParams = Sizeless;
  try {
    return await fn();
  } finally {
    globalThis.URLSearchParams = native;
  }
}
