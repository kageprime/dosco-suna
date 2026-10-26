/**
 * Canonical store URLs: no storefront country (`/cg/`) and no `hl=` locale.
 * Each store picks the visitor's own region and language. Its own module so
 * the project page's mobile-app introduction reads them without pulling the
 * download page's catalog into the app chunk.
 */
export const APP_STORE_URL = 'https://apps.apple.com/app/kortix/id6754448524';
export const GOOGLE_PLAY_URL =
  'https://play.google.com/store/apps/details?id=com.kortix.application';

/**
 * The Android APK download. There is no store listing yet — Android ships as a
 * direct APK: `/download/android` 302s here (one hand-writable URL on
 * dosco.live), and the project page's mobile-app introduction links the same
 * route. The artifact URL is immutable per EAS build, so a future upload bumps
 * this constant.
 */
export const ANDROID_APK_URL =
  'https://expo.dev/artifacts/eas/-mbTSXE4nynNHqohTJ-Jwyn6iFbB1EpRLifkf_a-T00.apk';
