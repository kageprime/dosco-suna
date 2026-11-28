const { isConfiguredAppUrl } = require('./native-sender');

/**
 * Which page gets which browser permission in the shell. The default session
 * renders the app, but also agent-authored previews (iframes) and connector or
 * OAuth popups (child windows). Electron grants every permission without a
 * prompt unless a handler decides, so the handler is the boundary:
 *
 * - The microphone: only the main window's top frame on the configured app
 *   origin, audio only. The signed macOS build carries the audio-input
 *   entitlement (composer dictation), so a grant here is a real microphone.
 * - The app's own page (same window and frame rule): the permissions the web
 *   app uses. Nothing else, not even for the app.
 * - Any other page: only permissions that read nothing and reach no device.
 *   `openExternal` stays open to all: an OAuth popup hands off to `kortix://`.
 */
const APP_PERMISSIONS = new Set([
  'clipboard-sanitized-write', // copy buttons
  'notifications', // web-notifications.ts
  'fullscreen',
  'display-capture', // voice-call screen share
  'openExternal',
]);
const ANY_PAGE_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock', 'openExternal']);

/** The main window's own top frame on the configured app origin. */
function isAppPage({ webContents, appWebContents, requestingUrl, isMainFrame }, appUrl) {
  if (!webContents || !appWebContents || webContents !== appWebContents) return false;
  if (isMainFrame === false) return false;
  return isConfiguredAppUrl(requestingUrl, appUrl);
}

function allowsMedia(request, appUrl) {
  if (!isAppPage(request, appUrl)) return false;
  const types = Array.isArray(request.mediaTypes) ? request.mediaTypes : [];
  return types.length > 0 && types.every((type) => type === 'audio');
}

function allowsPermission(permission, request, appUrl) {
  if (permission === 'media') return allowsMedia(request, appUrl);
  if (ANY_PAGE_PERMISSIONS.has(permission)) return true;
  return APP_PERMISSIONS.has(permission) && isAppPage(request, appUrl);
}

/**
 * Install the policy on a session. `appWebContents()` and `appUrl()` are read
 * per request: the main window is recreated and the app URL can change.
 */
function installMediaPermissionPolicy(session, { appWebContents, appUrl, onDenied = () => {} }) {
  session.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const allowed = allowsPermission(
      permission,
      {
        webContents,
        appWebContents: appWebContents(),
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaTypes,
      },
      appUrl(),
    );
    if (!allowed) onDenied(details.requestingUrl, permission);
    callback(allowed);
  });
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) =>
    allowsPermission(
      permission,
      {
        webContents,
        appWebContents: appWebContents(),
        requestingUrl: details.requestingUrl || requestingOrigin,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : [],
      },
      appUrl(),
    ),
  );
}

module.exports = { allowsMedia, allowsPermission, installMediaPermissionPolicy };
