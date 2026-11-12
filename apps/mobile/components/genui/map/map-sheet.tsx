/**
 * The map: MapLibre in a WebView. `MapWebView` draws it, inline in the transcript as a still picture or
 * interactive. `MapSheet` is the interactive map full screen: a React Native `Modal` (`presentationStyle`
 * `fullScreen`, slide up), not a bottom sheet or a dialog, so no pan-to-dismiss competes with panning the map,
 * and it opens the same way from the transcript and from inside a bottom sheet. It is mounted only while open.
 *
 * Full screen: the map runs edge to edge under the status bar. Back (top left) and Close (top right) float on
 * iOS 26 Liquid Glass circles (opaque `secondary` circles on Android and older iOS), inside the safe area. The
 * place panel floats over the bottom: one card per place, swiped sideways; a tap on a card's name shows that
 * place on the map.
 *
 * Back and Close: a place is selected while its popup is open (a pin tap or a panel card). Back, and the Android
 * back button (`onRequestClose`), then closes the popup and frames every place again; with nothing selected they
 * close the map. Close always closes the map.
 */
import { useEffect, useRef, useState, type ComponentRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, Modal, ScrollView, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewMessageEvent, WebViewOpenWindowEvent } from 'react-native-webview/lib/WebViewTypes';
import { useColorScheme } from 'nativewind';

import { HEADER_BUTTON_PT, HEADER_BUTTON_SIZE, HEADER_ICON_SIZE } from '@/components/kortix/header-button';
import { KortixLoader } from '@/components/kortix/kortix-loader';
import { GlassButtons, LIQUID_GLASS_AVAILABLE } from '@/components/kortix/liquid-glass';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { CaretLeftIcon, XIcon, type AppIcon } from '@/lib/icons';
import { decidePreviewNavigation } from '@/lib/utils/html-embed';
import { loadBundledText } from '@/lib/utils/asset-text';
import { THEME, withAlpha } from '@/lib/utils/theme';

import type { MapPlace, PlaceAction } from '@/lib/genui/map-geo';

import { openGenuiLink, openPlaceAction } from '../components/open-link';
import { mapDocument, type MapDocumentInput } from './map-html';
import { GenuiPlaceList, PlaceRow } from './place-list';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SCRIPT = require('@/assets/maplibre/maplibre-gl.webjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const CSS = require('@/assets/maplibre/maplibre-gl-css.webjs');
// Every URL reaches the guard, which allows only the inline document (see MermaidRendererHost).
const ORIGIN_WHITELIST = ['*'];

/**
 * Only the inline document loads. A top-frame web link (the attribution's) opens in the browser;
 * every other navigation is blocked. Tile and style fetches are requests, not navigations.
 */
function guardNavigation(request: ShouldStartLoadRequest): boolean {
  const action = decidePreviewNavigation(request.url, { isTopFrame: request.isTopFrame });
  if (action === 'open-external') openGenuiLink(request.url);
  return action === 'allow';
}

/** A `target="_blank"` link (MapLibre's attribution links) asks for a new window: open it in the browser. */
const openWindow = (event: WebViewOpenWindowEvent) => openGenuiLink(event.nativeEvent.targetUrl);

const ACTIONS: readonly PlaceAction[] = ['directions', 'website', 'call'];

/** No `load` from the page within this long counts as a failed basemap. */
const MAP_LOAD_TIMEOUT_MS = 10_000;

/**
 * The page's messages, validated: a popup button's `{ type: 'place', index, action }` (the page holds no link,
 * so native looks the place up and opens its own link), the basemap's `{ type: 'map', state }` (`load` or
 * `error`), and the open popup's `{ type: 'select', index }` (`null` when it closes). Any other message does nothing.
 */
function pageMessage(
  markers: readonly MapPlace[],
  raw: string,
  onState: (state: 'load' | 'error') => void,
  onSelect?: (index: number | null) => void,
): void {
  let message: { type?: unknown; index?: unknown; action?: unknown; state?: unknown };
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type === 'map') {
    if (message.state === 'load' || message.state === 'error') onState(message.state);
    return;
  }
  if (message?.type === 'select') {
    if (message.index === null) onSelect?.(null);
    else if (Number.isInteger(message.index) && markers[message.index as number]) onSelect?.(message.index as number);
    return;
  }
  if (message?.type !== 'place' || !Number.isInteger(message.index)) return;
  const place = markers[message.index as number];
  const action = ACTIONS.find((a) => a === message.action);
  if (place && action) openPlaceAction(place, action);
}

/** MapLibre's script and stylesheet: the shared bundled-asset reader (lib/utils/asset-text.ts) reads each once per app run and retries a failed read on the next open. */
function loadBundle() {
  return Promise.all([loadBundledText(SCRIPT), loadBundledText(CSS)]).then(([script, css]) => ({ script, css }));
}

export type MapSheetData = Omit<MapDocumentInput, 'markers' | 'script' | 'css' | 'background' | 'routeColor' | 'pin' | 'labels' | 'interactive' | 'chrome'> & {
  markers: MapPlace[];
};

/** The route line: the charts' first series colour (`charts.tsx` series 0 is `--chart-3`), as web's `routeRgb`. */
const ROUTE_COLOR = withAlpha(THEME.chart[2], 1);

/**
 * The map page in a WebView, in theme colors. Still (`interactive={false}`): no pan, zoom, or popups.
 * `onFail` fires once when the basemap cannot draw (web `map.tsx` `fallback`): the bundled assets fail to read,
 * the page reports a style error, the WebView reports a load or HTTP error or its web process dies, or no `load` comes within
 * `MAP_LOAD_TIMEOUT_MS`. The parent then shows the place rows in its place.
 */
export function MapWebView({
  data,
  interactive = true,
  onFail,
  chrome,
  onSelect,
  webRef,
}: {
  data: MapSheetData;
  interactive?: boolean;
  onFail?: () => void;
  /** Full screen: the native chrome over the page (`MapDocumentInput.chrome`). A change after load moves the frame, never reloads it. */
  chrome?: { top: number; bottom: number };
  /** Full screen: the open popup's place index, `null` when it closes. */
  onSelect?: (index: number | null) => void;
  /** Full screen: the WebView, so native can call the page's `kxSelect` / `kxOverview`. */
  webRef?: RefObject<ComponentRef<typeof WebView> | null>;
}) {
  const { t } = useTranslation();
  const { colorScheme } = useColorScheme();
  const theme = colorScheme === 'dark' ? THEME.dark : THEME.light;
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const directions = t('genui.directions', 'Directions');
  const website = t('genui.website', 'Website');
  const call = t('genui.call', 'Call');
  const [loaded, setLoaded] = useState(false);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const reported = useRef(false);
  // The chrome at the moment the page is built; later changes reach the loaded page through `kxInset`.
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const fail = () => {
    setFailed(true);
    if (reported.current) return;
    reported.current = true;
    onFailRef.current?.();
  };

  useEffect(() => {
    let alive = true;
    loadBundle().then(
      ({ script, css }) => {
        if (!alive) return;
        setHtml(
          mapDocument({
            ...data,
            script,
            css,
            interactive,
            chrome: chromeRef.current,
            background: withAlpha(theme.popover, 1),
            routeColor: ROUTE_COLOR,
            pin: {
              surface: withAlpha(theme.background, 1),
              ink: withAlpha(theme.foreground, 1),
              border: withAlpha(theme.border, 1),
              shadow: withAlpha(theme.foreground, 0.18),
              muted: withAlpha(theme.secondary, 1),
            },
            labels: { directions, website, call },
          }),
        );
      },
      () => alive && fail(),
    );
    return () => {
      alive = false;
    };
  }, [data, theme, interactive, directions, website, call]);

  // The page is built once with the chrome it had; a later change (the place panel measured, a rotation) reframes it.
  useEffect(() => {
    if (!loaded || !chrome) return;
    webRef?.current?.injectJavaScript(`window.kxInset && window.kxInset(${Math.round(chrome.top)}, ${Math.round(chrome.bottom)}); true;`);
  }, [loaded, chrome?.top, chrome?.bottom, webRef]);

  // The load timeout runs from the moment the page mounts until it reports load.
  useEffect(() => {
    if (!html || loaded || failed) return;
    const timer = setTimeout(fail, MAP_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [html, loaded, failed]);

  if (!html || failed) {
    return (
      <View className="flex-1 items-center justify-center">
        {failed ? <Text variant="muted">{t('genui.mapUnavailable', 'Map unavailable')}</Text> : <KortixLoader />}
      </View>
    );
  }
  return (
    <WebView
      ref={webRef}
      source={{ html, baseUrl: '' }}
      originWhitelist={ORIGIN_WHITELIST}
      onShouldStartLoadWithRequest={guardNavigation}
      onOpenWindow={openWindow}
      onMessage={(event: WebViewMessageEvent) =>
        pageMessage(data.markers, event.nativeEvent.data, (state) => (state === 'load' ? setLoaded(true) : fail()), onSelect)
      }
      onError={fail}
      onHttpError={fail}
      onContentProcessDidTerminate={fail}
      onRenderProcessGone={fail}
      javaScriptEnabled
      cacheEnabled={false}
      incognito
      bounces={false}
      scrollEnabled={interactive}
      overScrollMode="never"
      textZoom={100}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      style={{ flex: 1, backgroundColor: 'transparent' }}
    />
  );
}

/** The gap between the safe area and the floating controls, and between the controls and the page edge, in pt. */
const EDGE = 16;
const CONTROL_GAP = 8;
/** A place card in the panel: the window less the two edges, at most this wide, so the next card peeks in. */
const CARD_MAX = 320;
const CARD_GAP = 12;

/** A floating map control: a Liquid Glass circle on iOS 26 (the button inside the glass), an opaque circle elsewhere. */
function MapControl({ icon, label, onPress }: { icon: AppIcon; label: string; onPress: () => void }) {
  return (
    <GlassButtons>
      <Button
        variant={LIQUID_GLASS_AVAILABLE ? 'ghost' : 'secondary'}
        size={HEADER_BUTTON_SIZE}
        className="rounded-full"
        accessibilityLabel={label}
        onPress={onPress}
      >
        <Icon as={icon} size={HEADER_ICON_SIZE} className="text-foreground" />
      </Button>
    </GlassButtons>
  );
}

export function MapSheet({ title, data, onClose }: { title: string; data: MapSheetData; onClose: () => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const webRef = useRef<ComponentRef<typeof WebView>>(null);
  const panelRef = useRef<ComponentRef<typeof ScrollView>>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const places = data.markers;
  const single = places.length === 1;
  // The panel pads to the safe area on each side (landscape notch), so the cards fit inside it.
  const panelInner = width - Math.max(insets.left, EDGE) - Math.max(insets.right, EDGE);
  const cardWidth = single ? panelInner : Math.min(panelInner - 2 * CARD_GAP, CARD_MAX);
  const controlsTop = insets.top + CONTROL_GAP;
  const panelBottom = Math.max(insets.bottom, EDGE);
  const chrome = { top: controlsTop + HEADER_BUTTON_PT + CONTROL_GAP, bottom: panelHeight };

  const select = (index: number | null) => {
    setSelected(index);
    if (index !== null) panelRef.current?.scrollTo({ x: index * (cardWidth + CARD_GAP), animated: true });
  };
  const showPlace = (index: number) => {
    webRef.current?.injectJavaScript(`window.kxSelect && window.kxSelect(${index}); true;`);
    select(index);
  };
  // Back: a selected place goes back to every place; with none, or with the rows instead of the map, it closes.
  const back = () => {
    if (selected === null || failed) return onClose();
    webRef.current?.injectJavaScript('window.kxOverview && window.kxOverview(); true;');
    setSelected(null);
  };
  const backLabel = selected !== null && !failed ? t('genui.showAllPlaces', 'Show all places') : t('common.back', 'Back');

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={back}
      // The full-screen map shows no title row: announce it once the modal is
      // up, so the screen reader does not drop it during the slide-in.
      onShow={() => {
        if (title) AccessibilityInfo.announceForAccessibility(title);
      }}
    >
      <View className="flex-1 bg-background" accessibilityViewIsModal>
        {failed ? (
          // A failed basemap: the place rows, as inline and with the map off, below the controls.
          <ScrollView
            contentContainerStyle={{ paddingTop: chrome.top + CONTROL_GAP, paddingBottom: panelBottom, paddingLeft: Math.max(insets.left, EDGE), paddingRight: Math.max(insets.right, EDGE) }}
          >
            <GenuiPlaceList places={places} />
          </ScrollView>
        ) : (
          <>
            <MapWebView data={data} chrome={chrome} webRef={webRef} onSelect={select} onFail={() => setFailed(true)} />
            <View
              pointerEvents="box-none"
              className="absolute inset-x-0 bottom-0"
              style={{ paddingBottom: panelBottom }}
              onLayout={(e) => setPanelHeight(Math.round(e.nativeEvent.layout.height))}
            >
              <ScrollView
                ref={panelRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                decelerationRate="fast"
                snapToInterval={single ? undefined : cardWidth + CARD_GAP}
                snapToAlignment="start"
                contentContainerStyle={{ paddingLeft: Math.max(insets.left, EDGE), paddingRight: Math.max(insets.right, EDGE), gap: CARD_GAP }}
              >
                {places.map((place, index) => (
                  <View
                    key={place.id}
                    style={{ width: cardWidth }}
                    // A hairline border sets each card off the map tiles behind it; the selected place is a fill change.
                    className={`overflow-hidden rounded-2xl border border-border ${selected === index ? 'bg-accent' : 'bg-card'}`}
                  >
                    <PlaceRow place={place} compact onSelect={() => showPlace(index)} />
                  </View>
                ))}
              </ScrollView>
            </View>
          </>
        )}
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 flex-row justify-between"
          style={{ top: controlsTop, paddingLeft: Math.max(insets.left, EDGE), paddingRight: Math.max(insets.right, EDGE) }}
        >
          <MapControl icon={CaretLeftIcon} label={backLabel} onPress={back} />
          <MapControl icon={XIcon} label={t('genui.closeMap', 'Close map')} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
