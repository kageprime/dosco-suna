/**
 * Canonical store URLs for the Dosco mobile apps.
 *
 * UNPUBLISHED: the current store listings belong to the legacy Kortix apps,
 * and the Dosco apps are not ported yet. Until they are, every consumer renders
 * no store link at all — an auto-opening promo or a download row that sends
 * users to another platform's app is worse than no ad.
 *
 * Both surfaces (`/download` and the project-page promo) derive their elements
 * from these constants and disappear while they are null. When the real Dosco
 * listings go live, fill the values here and every surface restores itself
 * without further edits.
 */
export const APP_STORE_URL = null;
export const GOOGLE_PLAY_URL = null;
