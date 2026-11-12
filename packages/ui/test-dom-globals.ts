// DOM classes and frame timers as bare globals for bun tests that put a
// happy-dom `window` on `globalThis` themselves. Base UI's positioning
// (Floating UI) reads `Element`, `HTMLElement`, `Node` and `ShadowRoot`, and
// its transitions call `requestAnimationFrame`, as bare globals; a test that
// lifts only `window` and `document` used to die with
// `ReferenceError: Element is not defined`.
//
// Each global is a lazy accessor that reads the test's current `window`, so
// it follows whichever window the test installed. With no window a global
// stays `undefined`; a hand-built window without DOM classes gets empty
// placeholder classes. Test for a frame clock with `typeof`, not `in`. A test that assigns or defines its own value replaces the
// accessor with a plain property.
const NAMES = [
  'Element',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'Node',
  'ShadowRoot',
  'DocumentFragment',
  'customElements',
  'requestAnimationFrame',
  'cancelAnimationFrame',
] as const;

// A window a test built by hand (an `EventTarget` with timers) has no DOM
// classes. `x instanceof Element` must then be false, not throw.
const CLASSES = new Set(['Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Node', 'ShadowRoot', 'DocumentFragment']);
const placeholders = new Map<string, unknown>();
const placeholder = (name: string) => {
  if (!placeholders.has(name)) placeholders.set(name, class {});
  return placeholders.get(name);
};

for (const name of NAMES) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      const win = (globalThis as unknown as { window?: Record<string, unknown> }).window;
      const value = win?.[name];
      if (win && value === undefined && CLASSES.has(name)) return placeholder(name);
      if (name.endsWith('AnimationFrame')) {
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(win) : undefined;
      }
      return value;
    },
    set(value: unknown) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value,
      });
    },
  });
}
