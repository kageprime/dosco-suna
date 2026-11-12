/**
 * ArtifactWebView — one artifact page, from its signed content URL.
 *
 * The URL (`version.view_url`, `/v1/artifacts/s/<token>/`) is the credential:
 * the WebView sends no Authorization header and shares no cookie with the app.
 * Never copy `SandboxPreviewSheet` here: it attaches the live session token to
 * every URL on the API host, and the content URL is on that host when the
 * deployment has no separate content origin, so an agent-written page would
 * receive the token.
 *
 * Cookies: `incognito`, so the page sees no cookie the app's other
 * WebViews hold for the API host.
 *
 * Navigation (`decideArtifactNavigation`): the artifact's own directory loads
 * here, frames inside the page load, and any other link opens in the in-app
 * browser. No message bridge, no file access, no mixed content, no windows.
 */

import * as React from 'react';
import { Platform, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';

import { KortixLoader } from '@/components/kortix/kortix-loader';
import { artifactContentPrefix, decideArtifactNavigation } from '@/lib/artifacts/artifacts';
import { openArtifactLink } from '@/lib/artifacts/open-artifact-link';
import { log } from '@/lib/logger';
import { openLink } from '@/lib/utils/open-link';
import { resolveLocalUrl } from '@/lib/utils/resolve-local-url';

interface ArtifactWebViewProps {
  /** The artifact's signed `version.view_url`. */
  viewUrl: string;
  /** Behind the page while it loads, and behind a page with no background of its own. */
  background: string;
  /** Space the page keeps clear at the bottom (the home indicator). */
  bottomInset: number;
  /** The page answered with an HTTP error (main frame). */
  onHttpError: (status: number) => void;
  /** The page could not load at all (offline, DNS, TLS), or `viewUrl` is not a content URL. */
  onLoadError: () => void;
}

export function ArtifactWebView({ viewUrl, background, bottomInset, onHttpError, onLoadError }: ArtifactWebViewProps) {
  // On a phone, the local stack's `localhost` is the phone itself.
  const uri = React.useMemo(() => resolveLocalUrl(viewUrl), [viewUrl]);
  const prefix = React.useMemo(() => artifactContentPrefix(uri), [uri]);
  // The renderer process died (memory pressure): mount a new WebView.
  const [generation, setGeneration] = React.useState(0);
  const restart = React.useCallback(() => setGeneration((value) => value + 1), []);

  const invalid = prefix === null;
  React.useEffect(() => {
    if (invalid) onLoadError();
  }, [invalid, onLoadError]);

  const webViewRef = React.useRef<React.ElementRef<typeof WebView>>(null);

  // A link to another artifact of this project opens in the viewer (the
  // browser would ask the reader to sign in again); any other web link in the
  // in-app browser.
  const openOutside = React.useCallback((url: string) => {
    if (openArtifactLink(url)) return;
    openLink(url).catch((error) => log.warn('[ArtifactWebView] Failed to open link:', error));
  }, []);

  const guard = React.useCallback(
    (request: ShouldStartLoadRequest) => {
      if (!prefix) return false;
      const action = decideArtifactNavigation(request.url, prefix, { isTopFrame: request.isTopFrame });
      if (action === 'open-external') openOutside(request.url);
      return action === 'allow';
    },
    [openOutside, prefix],
  );

  // iOS: a navigation with no target frame (`target="_blank"`, `window.open`)
  // comes here, never to the guard. The guard would see it as a frame load:
  // iOS reports `isTopFrame` by comparing the URL with the main document URL,
  // and a new window has none. Decide it as the top frame it would become.
  const openWindow = React.useCallback(
    (event: WebViewOpenWindowEvent) => {
      const url = event.nativeEvent.targetUrl;
      if (!prefix) return;
      const action = decideArtifactNavigation(url, prefix, { isTopFrame: true });
      if (action === 'allow') {
        // A page of this artifact: load it here, through the guard again.
        webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
      } else if (action === 'open-external') {
        openOutside(url);
      }
    },
    [openOutside, prefix],
  );

  const loading = React.useCallback(
    () => (
      <View className="absolute inset-0 items-center justify-center" style={{ backgroundColor: background }}>
        <KortixLoader />
      </View>
    ),
    [background],
  );

  if (invalid) return <View style={{ flex: 1, backgroundColor: background }} />;

  return (
    // Android draws edge to edge and has no content inset: pad the container.
    <View style={{ flex: 1, backgroundColor: background, paddingBottom: Platform.OS === 'android' ? bottomInset : 0 }}>
      <WebView
        ref={webViewRef}
        key={generation}
        source={{ uri }}
        style={{ flex: 1, backgroundColor: background }}
        // `*`: every URL reaches the guard. With the default http(s) list, a
        // `tel:` or app deep link goes straight to `Linking.openURL`.
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={guard}
        // No new window. iOS hands every new-window navigation to
        // `onOpenWindow` and cancels it; Android with one window loads a
        // `target="_blank"` link here, as a top frame, through the guard.
        onOpenWindow={openWindow}
        setSupportMultipleWindows={false}
        javaScriptEnabled
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled
        // No cookie of the app's other WebViews: the API host can hold the
        // sandbox `__preview_session` cookie, and the content is served from
        // that host. iOS: a non-persistent data store. Android: the shared
        // CookieManager is emptied first (the map and Mermaid views do the same).
        incognito
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        geolocationEnabled={false}
        mediaCapturePermissionGrantType="deny"
        allowsInlineMediaPlayback
        allowsFullscreenVideo
        mediaPlaybackRequiresUserAction
        allowsLinkPreview={false}
        allowsBackForwardNavigationGestures
        contentInset={{ bottom: bottomInset }}
        automaticallyAdjustContentInsets={false}
        startInLoadingState
        renderLoading={loading}
        onHttpError={(event) => onHttpError(event.nativeEvent.statusCode)}
        onError={onLoadError}
        onRenderProcessGone={restart}
        onContentProcessDidTerminate={restart}
      />
    </View>
  );
}
