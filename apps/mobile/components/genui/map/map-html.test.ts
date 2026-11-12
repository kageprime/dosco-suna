import { describe, expect, test } from 'bun:test';

import { mapDocument, pinValue, scriptJson, type MapDocumentInput } from './map-html';

const PIN = { surface: 'white', ink: 'black', border: 'gray', shadow: 'gray', muted: 'silver' };
const LABELS = { directions: 'Directions', website: 'Website', call: 'Call' };

type El = {
  tag: string;
  className: string;
  textContent: string;
  src?: string;
  onclick?: () => void;
  children: El[];
  appendChild: (child: El) => void;
};
/** Every piece of text in a popup, depth first: `img:<src>` for a photo, `[label]` for a button. */
const flat = (el: El): string[] =>
  el.tag === 'img' ? [`img:${el.src}`] : el.tag === 'button' ? [`[${el.textContent}]`] : el.textContent ? [el.textContent] : el.children.flatMap(flat);

type Camera = Record<string, unknown> & { bounds?: { points: number[][] } };

/** Runs the page's own script against a recording stand-in for maplibregl, the way the WebView would. */
function runPage(input: Partial<MapDocumentInput>, events: string[] = ['load']) {
  const html = mapDocument({ script: '', css: '', styleUrl: 's', markers: [], background: 'white', routeColor: 'black', pin: PIN, labels: LABELS, ...input });
  const page = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const seen = {
    camera: null as Camera | null,
    markers: [] as number[][],
    popups: [] as string[][],
    buttons: [] as El[],
    posted: [] as unknown[],
    layers: [] as unknown[],
    pins: [] as string[][],
    controls: 0,
    /** Every camera call after construction, as `name:args`. */
    moves: [] as string[],
    open: [] as boolean[],
    window: {} as Record<string, unknown>,
    /** A tap on pin n: its popup opens or closes. */
    toggles: [] as (() => void)[],
  };
  const handlers: Record<string, () => void> = {};
  const element = (tag: string): El => {
    const el: El = { tag, className: '', textContent: '', children: [], appendChild: (child) => el.children.push(child) };
    if (tag === 'button') seen.buttons.push(el);
    return el;
  };
  const maplibregl = {
    LngLatBounds: class {
      points: number[][] = [];
      extend(point: number[]) {
        this.points.push(point);
      }
    },
    Map: class {
      constructor(camera: Camera) {
        if (camera.style === 'throw') throw new Error('Failed to initialize WebGL');
        seen.camera = camera;
      }
      addControl() {
        seen.controls++;
      }
      on(event: string, handler: () => void) {
        handlers[event] = handler;
      }
      setPadding(padding: unknown) {
        seen.moves.push(`setPadding:${JSON.stringify(padding)}`);
      }
      fitBounds(_bounds: unknown, options: unknown) {
        seen.moves.push(`fitBounds:${JSON.stringify(options)}`);
      }
      easeTo(options: unknown) {
        seen.moves.push(`easeTo:${JSON.stringify(options)}`);
      }
      getZoom() {
        return 10;
      }
      addSource() {}
      addLayer(layer: unknown) {
        seen.layers.push(layer);
      }
    },
    NavigationControl: class {},
    Popup: class {
      index = seen.open.length;
      events: Record<string, () => void> = {};
      constructor() {
        seen.open.push(false);
      }
      setDOMContent(el: El) {
        seen.popups.push(flat(el));
        return this;
      }
      on(event: string, handler: () => void) {
        this.events[event] = handler;
        return this;
      }
      isOpen() {
        return seen.open[this.index]!;
      }
      /** The page's own open and close, as MapLibre fires them. */
      toggle() {
        seen.open[this.index] = !seen.open[this.index];
        this.events[seen.open[this.index] ? 'open' : 'close']?.();
      }
      remove() {
        if (seen.open[this.index]) this.toggle();
        return this;
      }
    },
    Marker: class {
      popup: { toggle: () => void } | null = null;
      constructor(options?: { element?: El }) {
        const pin = options?.element;
        if (pin) seen.pins.push(pin.children.map((c) => `${c.className}:${c.textContent}`));
      }
      setLngLat(point: number[]) {
        seen.markers.push(point);
        return this;
      }
      setPopup(popup: { toggle: () => void }) {
        this.popup = popup;
        seen.toggles.push(() => popup.toggle());
        return this;
      }
      togglePopup() {
        this.popup?.toggle();
        return this;
      }
      addTo() {
        return this;
      }
    },
  };
  const window: Record<string, unknown> = { ReactNativeWebView: { postMessage: (message: string) => seen.posted.push(JSON.parse(message)) } };
  seen.window = window;
  new Function('maplibregl', 'document', 'window', page)(maplibregl, { createElement: element }, window);
  for (const event of events) handlers[event]?.();
  return seen;
}

describe('map document', () => {
  test('model text cannot close the script tag', () => {
    const json = scriptJson({ label: '</script><script>alert(1)</script>' });
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json).label).toBe('</script><script>alert(1)</script>');
  });

  test('line and paragraph separators are escaped', () => {
    const raw = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const json = scriptJson(raw);
    expect(json).toBe('"a\\u2028b\\u2029c"');
    expect(JSON.parse(json)).toBe(raw);
  });

  test('builds a document with markers as [lng, lat] and the route converted', () => {
    const html = mapDocument({
      script: 'var maplibregl = {};',
      css: '.x{}',
      styleUrl: 'https://tiles.example.com/style.json',
      markers: [{ lat: 48.85, lng: 2.35, label: '</script>evil' }],
      route: [[48.85, 2.35], [48.86, 2.36]],
      background: 'rgb(255,255,255)',
      routeColor: 'rgba(0,0,0,0.7)',
      pin: PIN,
      labels: LABELS,
    });
    expect(html).toContain('"lngLat":[2.35,48.85]');
    expect(html).toContain('"route":[[2.35,48.85],[2.36,48.86]]');
    expect(html).not.toContain('</script>evil');
    expect(html).toContain('https://tiles.example.com/style.json');
    expect(html).toContain('"routeColor":"rgba(0,0,0,0.7)"');
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test('a script asset containing </script> cannot break out', () => {
    const html = mapDocument({ script: 'x="</script>"', css: '', styleUrl: 's', markers: [], background: 'white', routeColor: 'black', pin: PIN, labels: LABELS });
    expect(html.match(/<\/script>/g)?.length).toBe(2);
  });

  test('one place opens centred on it at the given zoom, its popup shows the label and description', () => {
    const seen = runPage({ markers: [{ lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' }], zoom: 12 });
    expect(seen.camera).toMatchObject({ center: [2.35, 48.85], zoom: 12, style: 's', container: 'map' });
    expect(seen.markers).toEqual([[2.35, 48.85]]);
    expect(seen.popups).toEqual([['Louvre', 'Museum', '[Directions]']]);
    expect(seen.layers).toEqual([]);
  });

  test('several places and the route are all inside the first frame; the route draws as a line', () => {
    const seen = runPage({
      markers: [
        { lat: 48.85, lng: 2.35, label: 'A' },
        { lat: 48.86, lng: 2.36, label: 'B' },
      ],
      route: [[48.8, 2.3], [48.9, 2.4]],
    });
    expect(seen.camera?.bounds?.points).toEqual([[2.35, 48.85], [2.36, 48.86], [2.3, 48.8], [2.4, 48.9]]);
    expect(seen.camera?.fitBoundsOptions).toEqual({ padding: 48, maxZoom: 16 });
    expect(seen.layers).toEqual([expect.objectContaining({ type: 'line', paint: { 'line-width': 3, 'line-color': 'black' } })]);
  });

  test('route points outside lat ±90 / lng ±180 are dropped, so the camera never sees an invalid LngLat', () => {
    // [-122.4, 37.7] is GeoJSON order written by mistake: lat -122.4 is off the globe.
    const html = mapDocument({
      script: '',
      css: '',
      styleUrl: 's',
      markers: [{ lat: 37.77, lng: -122.42, label: 'A' }],
      route: [[37.77, -122.42], [-122.4, 37.7], [37.8, -122.41], [37.79, 181], [Number.NaN, 1]],
      background: 'white',
      routeColor: 'black',
      pin: PIN,
      labels: LABELS,
    });
    expect(html).toContain('"route":[[-122.42,37.77],[-122.41,37.8]]');
  });

  test('a route with fewer than 2 valid points is omitted: no line, and the frame holds only the places', () => {
    const markers = [{ lat: 37.77, lng: -122.42, label: 'A' }];
    expect(mapDocument({ script: '', css: '', styleUrl: 's', markers, route: [[-122.4, 37.7], [37.8, -122.41]], background: 'white', routeColor: 'black', pin: PIN, labels: LABELS })).toContain('"route":[]');
    const seen = runPage({ markers, route: [[-122.4, 37.7], [-122.5, 37.6]] });
    expect(seen.camera).toMatchObject({ center: [-122.42, 37.77], zoom: 14 });
    expect(seen.layers).toEqual([]);
  });

  test("a pin is web's MapPin: the figure in a bubble when it has a digit, else a dot; the place name under it", () => {
    const seen = runPage({
      markers: [
        { lat: 1, lng: 1, label: 'Taj', value: '★ 4.7' },
        { lat: 2, lng: 2, label: 'Oberoi', value: 'Luxury' },
        { lat: 3, lng: 3, label: 'Trident' },
      ],
    });
    expect(seen.pins).toEqual([
      ['kx-bubble:★ 4.7', 'kx-name:Taj'],
      ['kx-dot:', 'kx-name:Oberoi'],
      ['kx-dot:', 'kx-name:Trident'],
    ]);
    expect(pinValue('$120')).toBe('$120');
    expect(pinValue('Luxury')).toBeUndefined();
  });

  test('the inline map is a still picture: no pan or zoom, no controls, no popups; the full-screen one has all three', () => {
    const markers = [{ lat: 48.85, lng: 2.35, label: 'Louvre', description: 'Museum' }];
    const still = runPage({ markers, interactive: false });
    expect(still.camera).toMatchObject({ interactive: false });
    expect([still.controls, still.popups.length]).toEqual([0, 0]);
    const live = runPage({ markers });
    expect(live.camera).toMatchObject({ interactive: true });
    expect([live.controls, live.popups.length]).toEqual([1, 1]);
  });

  test("a pin's popup is web's place card: photo, name, value · kind, description, then Directions, Website, Call", () => {
    const seen = runPage({
      markers: [
        {
          lat: 19.04,
          lng: 72.82,
          label: 'Taj Lands End',
          description: 'Bandstand',
          value: '★ 4.6',
          kind: 'Hotel',
          href: 'https://taj.example.com/',
          image: 'https://img.example.com/taj.jpg',
          phone: '+91 22 6668-1234',
        },
        // A word value still shows in the card (only the pin skips it); a phone too short to dial has no Call.
        { lat: 1, lng: 1, label: 'Oberoi', value: 'Luxury', phone: '12' },
      ],
    });
    expect(seen.popups).toEqual([
      ['img:https://img.example.com/taj.jpg', 'Taj Lands End', '★ 4.6 · Hotel', 'Bandstand', '[Directions]', '[Website]', '[Call]'],
      ['Oberoi', 'Luxury', '[Directions]'],
    ]);
    expect(seen.buttons.map((b) => b.className)).toEqual(['kx-act kx-primary', 'kx-act', 'kx-act', 'kx-act kx-primary']);
  });

  test('a popup action posts the place index and the action to native; the page opens nothing itself', () => {
    const seen = runPage({
      markers: [
        { lat: 1, lng: 1, label: 'A' },
        { lat: 2, lng: 2, label: 'B', href: 'https://b.example.com/', phone: '+1 555 0100' },
      ],
    });
    seen.posted.length = 0;
    for (const button of seen.buttons) button.onclick!();
    expect(seen.posted).toEqual([
      { type: 'place', index: 0, action: 'directions' },
      { type: 'place', index: 1, action: 'directions' },
      { type: 'place', index: 1, action: 'website' },
      { type: 'place', index: 1, action: 'call' },
    ]);
    // The page holds no link: native resolves the place and opens it.
    const html = mapDocument({ script: '', css: '', styleUrl: 's', markers: [{ lat: 2, lng: 2, label: 'B', href: 'https://b.example.com/', phone: '+1 555 0100' }], background: 'white', routeColor: 'black', pin: PIN, labels: LABELS });
    expect(html).not.toContain('b.example.com');
    expect(html).not.toContain('555');
  });

  test('model text in the card stays data, and a photo that is not http(s) is dropped', () => {
    const evil = '</script><img src=x onerror=alert(1)>';
    const html = mapDocument({
      script: '',
      css: '',
      styleUrl: 's',
      markers: [{ lat: 1, lng: 1, label: evil, description: evil, value: evil, kind: evil, image: 'javascript:alert(1)' }],
      background: 'white',
      routeColor: 'black',
      pin: PIN,
      labels: { directions: evil, website: 'W', call: 'C' },
    });
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    expect(html).not.toContain('javascript:alert');
    const seen = runPage({ markers: [{ lat: 1, lng: 1, label: evil, image: 'javascript:alert(1)' }] });
    expect(seen.popups).toEqual([[evil, '[Directions]']]);
  });

  test("the page reports its basemap to native: load once it draws, error when the style fails before it loads", () => {
    expect(runPage({}, ['style.load', 'load']).posted).toEqual([{ type: 'map', state: 'load' }]);
    // The style (or its worker) failed: MapLibre never fires load.
    expect(runPage({}, ['error']).posted).toEqual([{ type: 'map', state: 'error' }]);
    // A tile error after the style loaded still ends in load (web `watchMapLoad`): not a failure.
    expect(runPage({}, ['style.load', 'error', 'load']).posted).toEqual([{ type: 'map', state: 'load' }]);
    // No WebGL: MapLibre throws in its constructor, before any event.
    expect(runPage({ styleUrl: 'throw' }, []).posted).toEqual([{ type: 'map', state: 'error' }]);
  });

  test('full screen: the camera frames the places inside the area the native chrome leaves, and the controls move clear', () => {
    const markers = [
      { lat: 48.85, lng: 2.35, label: 'A' },
      { lat: 48.86, lng: 2.36, label: 'B' },
    ];
    const html = mapDocument({ script: '', css: '', styleUrl: 's', markers, background: 'white', routeColor: 'black', pin: PIN, labels: LABELS, chrome: { top: 119.4, bottom: 180 } });
    expect(html).toContain(':root{--kx-top:119px;--kx-bottom:180px}');
    expect(html).toContain('.maplibregl-ctrl-top-right{top:var(--kx-top)}');
    const seen = runPage({ markers, chrome: { top: 119, bottom: 180 } });
    expect(seen.moves).toEqual(['setPadding:{"top":119,"bottom":180,"left":0,"right":0}', 'fitBounds:{"padding":48,"maxZoom":16,"duration":0}']);
    // One place: centred in the uncovered area, at its zoom.
    const one = runPage({ markers: [markers[0]!], chrome: { top: 119, bottom: 180 } });
    expect(one.moves.at(-1)).toBe('easeTo:{"center":[2.35,48.85],"zoom":14,"duration":0}');
    // The inline map has no chrome: no padding, no reframe.
    expect(runPage({ markers }).moves).toEqual([]);
  });

  test('full screen: an open popup is the selected place; kxSelect opens one, kxOverview closes it and frames every place', () => {
    const markers = [
      { lat: 48.85, lng: 2.35, label: 'A' },
      { lat: 48.86, lng: 2.36, label: 'B' },
    ];
    const seen = runPage({ markers, chrome: { top: 100, bottom: 100 } });
    seen.posted.length = 0;
    seen.moves.length = 0;
    // A pin tap.
    seen.toggles[0]!();
    expect(seen.posted).toEqual([{ type: 'select', index: 0 }]);
    // A panel card: the other popup closes, this one opens, the camera eases to it.
    (seen.window.kxSelect as (i: number) => void)(1);
    expect(seen.open).toEqual([false, true]);
    expect(seen.posted.slice(1)).toEqual([{ type: 'select', index: null }, { type: 'select', index: 1 }]);
    expect(seen.moves).toEqual(['easeTo:{"center":[2.36,48.86],"zoom":14,"duration":400}']);
    (seen.window.kxSelect as (i: number) => void)(7);
    expect(seen.open).toEqual([false, true]);
    // Back.
    (seen.window.kxOverview as () => void)();
    expect(seen.open).toEqual([false, false]);
    expect(seen.posted.at(-1)).toEqual({ type: 'select', index: null });
    expect(seen.moves.at(-1)).toBe('fitBounds:{"padding":48,"maxZoom":16,"duration":400}');
  });

  test('full screen: kxInset moves the frame while the user has not moved the map, and only the padding after', () => {
    const markers = [{ lat: 48.85, lng: 2.35, label: 'A' }];
    const seen = runPage({ markers, chrome: { top: 100, bottom: 0 } });
    seen.moves.length = 0;
    (seen.window.kxInset as (t: number, b: number) => void)(100, 180);
    expect(seen.moves).toEqual(['setPadding:{"top":100,"bottom":180,"left":0,"right":0}', 'easeTo:{"center":[2.35,48.85],"zoom":14,"duration":0}']);
    seen.toggles[0]!();
    seen.moves.length = 0;
    (seen.window.kxInset as (t: number, b: number) => void)(100, 200);
    expect(seen.moves).toEqual(['setPadding:{"top":100,"bottom":200,"left":0,"right":0}']);
  });
});
