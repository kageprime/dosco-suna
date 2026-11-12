'use client';

/**
 * The `@kortix/ui` primitives run on Base UI and keep the prop and attribute
 * contract they had on Radix. `@kortix/ui` is published, so customer apps and
 * our own call sites keep `asChild`, `data-state`, `--radix-*` CSS variables,
 * `onEscapeKeyDown` / `onPointerDownOutside` / `onInteractOutside`, and
 * `onOpenAutoFocus` / `onCloseAutoFocus`. This file translates them.
 */

import * as React from 'react';

type AnyProps = Record<string, unknown>;

/* ---------- asChild → render ---------- */

/**
 * Turns Radix `asChild` into Base UI `render`: the only child becomes the
 * rendered element and keeps its own children.
 */
export function asChildRender(
  asChild: boolean | undefined,
  children: React.ReactNode,
): { render?: React.ReactElement; children?: React.ReactNode } {
  if (asChild && React.isValidElement(children)) {
    return {
      render: children,
      children: (children.props as { children?: React.ReactNode }).children,
    };
  }
  return { children };
}

/* ---------- data-state ---------- */

/**
 * A Base UI `render` function that adds a Radix `data-state` attribute, on
 * the `asChild` element when there is one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function stateRender<S = any>(
  tag: keyof React.JSX.IntrinsicElements,
  toState: (state: S) => string | undefined,
  element?: React.ReactElement,
  extra?: (state: S) => AnyProps,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function renderWithState(props: any, state: S): React.ReactElement {
    const attrs = { ...props, 'data-state': toState(state), ...extra?.(state) };
    if (element) {
      // `render` with an element merges into it; a function must merge itself.
      const own = element.props as AnyProps;
      return React.cloneElement(element, mergeElementProps(own, attrs));
    }
    return React.createElement(tag, attrs);
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const openState = (s: any) => (s.open ? 'open' : 'closed');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const checkedState = (s: any) =>
  s.indeterminate ? 'indeterminate' : s.checked ? 'checked' : 'unchecked';

/**
 * A Base UI `render` for a form control: a native `<button>` that writes
 * `data-state` and `disabled` last, in Radix's attribute order.
 * Switch, radio and tab items use it too.
 */
export function controlRender<S extends { disabled?: boolean }>(toState: (state: S) => string) {
  function renderControl(props: React.ComponentProps<'button'>, state: S) {
    const { disabled: _disabled, ...rest } = props;
    return <button {...rest} data-state={toState(state)} disabled={state.disabled || undefined} />;
  }
  return renderControl;
}

/** Merges props the way Radix `Slot` did: handlers chain, classes join, styles merge. */
export function mergeElementProps(own: AnyProps, slot: AnyProps): AnyProps {
  const merged: AnyProps = { ...slot, ...own };
  for (const key of Object.keys(slot)) {
    const a = slot[key];
    const b = own[key];
    if (/^on[A-Z]/.test(key) && typeof a === 'function' && typeof b === 'function') {
      merged[key] = (...args: unknown[]) => {
        (b as (...x: unknown[]) => void)(...args);
        (a as (...x: unknown[]) => void)(...args);
      };
    } else if (key === 'className' && a && b) {
      merged[key] = `${a as string} ${b as string}`;
    } else if (key === 'style' && a && b) {
      merged[key] = { ...(a as object), ...(b as object) };
    } else if (key === 'ref') {
      merged[key] =
        b && a ? composeRefs(a as React.Ref<unknown>, b as React.Ref<unknown>) : (b ?? a);
    } else if (key === 'children') {
      merged[key] = b ?? a;
    }
  }
  return merged;
}

export function composeRefs<T>(...refs: Array<React.Ref<T> | undefined>): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

/* ---------- Radix-style dismiss and focus events ---------- */

/** The part of a Radix dismiss event that consumers read. */
export interface LegacyDismissEvent {
  readonly target: EventTarget | null;
  readonly detail: { originalEvent: Event };
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export interface DismissHandlers {
  onEscapeKeyDown?: (event: KeyboardEvent & LegacyDismissEvent) => void;
  onPointerDownOutside?: (event: LegacyDismissEvent) => void;
  onFocusOutside?: (event: LegacyDismissEvent) => void;
  onInteractOutside?: (event: LegacyDismissEvent) => void;
}

function legacyEvent(native: Event | undefined): LegacyDismissEvent {
  let prevented = false;
  const original = native ?? new Event('dismiss');
  const event = {
    target: original.target,
    detail: { originalEvent: original },
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
  // Escape handlers read `key` and friends from the keyboard event.
  return new Proxy(event, {
    get(obj, prop, receiver) {
      if (prop in obj) return Reflect.get(obj, prop, receiver);
      const value = (original as unknown as AnyProps)[prop as string];
      return typeof value === 'function' ? (value as () => unknown).bind(original) : value;
    },
  }) as LegacyDismissEvent;
}

/** The Base UI change details passed to `onOpenChange`. */
export interface ChangeDetails {
  reason: string;
  event?: Event;
  cancel(): void;
}

type DismissRegistry = React.MutableRefObject<DismissHandlers>;
/** The nearest root of each kind, so a popover inside a hover card registers with the popover. */
type DismissScope = Readonly<Record<string, DismissRegistry>>;
const DismissContext = React.createContext<DismissScope>({});

/**
 * The root half: wraps `onOpenChange` so a close that a content-level Radix
 * handler prevented is cancelled.
 */
export function useDismissRoot<A extends unknown[]>(
  onOpenChange: ((open: boolean, ...rest: A) => void) | undefined,
) {
  const registry = React.useRef<DismissHandlers>({});
  const handle = React.useCallback(
    (open: boolean, details?: ChangeDetails) => {
      if (!open && details && runDismissHandlers(registry.current, details)) {
        details.cancel();
        return;
      }
      (onOpenChange as ((open: boolean) => void) | undefined)?.(open);
    },
    [onOpenChange],
  );
  return { registry, onOpenChange: handle };
}

/** Returns true when a handler called `preventDefault()`. */
function runDismissHandlers(h: DismissHandlers, details: ChangeDetails): boolean {
  const event = legacyEvent(details.event);
  if (details.reason === 'escape-key') {
    h.onEscapeKeyDown?.(event as KeyboardEvent & LegacyDismissEvent);
  } else if (details.reason === 'outside-press') {
    h.onPointerDownOutside?.(event);
    if (!event.defaultPrevented) h.onInteractOutside?.(event);
  } else if (details.reason === 'focus-out') {
    h.onFocusOutside?.(event);
    if (!event.defaultPrevented) h.onInteractOutside?.(event);
  } else {
    return false;
  }
  return event.defaultPrevented;
}

export function DismissProvider({
  kind,
  registry,
  children,
}: {
  /** The component family: `dialog`, `menu`, `select`, ... */
  kind: string;
  registry: DismissRegistry;
  children: React.ReactNode;
}) {
  const parent = React.useContext(DismissContext);
  const value = React.useMemo(() => ({ ...parent, [kind]: registry }), [parent, kind, registry]);
  return <DismissContext.Provider value={value}>{children}</DismissContext.Provider>;
}

/** The content half: registers this content's Radix dismiss handlers with the nearest root of `kind`. */
export function useDismissContent(kind: string, handlers: DismissHandlers) {
  const registry = React.useContext(DismissContext)[kind];
  if (registry) registry.current = handlers;
}

/**
 * Radix `onOpenAutoFocus` / `onCloseAutoFocus` → Base UI `initialFocus` /
 * `finalFocus`, plus Radix's rule that an `autoFocus` field inside the popup
 * keeps focus on open. As in Radix, the handler gets a cancelable event dispatched on
 * the popup, so `event.currentTarget` is the popup; `preventDefault()` keeps
 * focus where the handler put it.
 */
export function focusProps(
  getPopup: () => HTMLElement | null,
  onOpenAutoFocus?: (event: Event) => void,
  onCloseAutoFocus?: (event: Event) => void,
) {
  const run = (type: string, handler: (event: Event) => void) => {
    const event = new CustomEvent(type, { cancelable: true });
    const node = getPopup();
    if (!node) {
      handler(event);
      return !event.defaultPrevented;
    }
    node.addEventListener(type, handler, { once: true });
    node.dispatchEvent(event);
    return !event.defaultPrevented;
  };
  return {
    // As in Radix, focus that is already inside the popup when it opens (an
    // `autoFocus` field) stays there; Base UI would move it to its own pick.
    initialFocus: () => {
      const node = getPopup();
      if (node) returnFocusTo.set(node, document.activeElement);
      if (node && node.contains(document.activeElement)) return false;
      return onOpenAutoFocus ? run('focusScope.autoFocusOnMount', onOpenAutoFocus) : true;
    },
    // Focus returns to where it was before the popup opened, a task after the
    // close, and only when nothing else took it meanwhile: a menu item that
    // opens a dialog leaves focus in the dialog's `autoFocus` field. Base UI
    // would move focus back to the trigger after its exit, over the dialog.
    finalFocus: () => {
      const node = getPopup();
      if (onCloseAutoFocus && !run('focusScope.autoFocusOnUnmount', onCloseAutoFocus)) return false;
      const target = node ? returnFocusTo.get(node) : null;
      // Nothing was focused at open (a click that does not focus): Base UI's default, the trigger.
      if (!(target instanceof HTMLElement) || target === document.body) return true;
      setTimeout(() => {
        const active = document.activeElement;
        const lost = !active || active === document.body || (node?.contains(active) ?? false);
        if (lost && target.isConnected) target.focus({ preventScroll: true });
      }, 0);
      return false;
    },
  };
}

/** The element that had focus when each popup opened. */
const returnFocusTo = new WeakMap<HTMLElement, Element | null>();

/**
 * Base UI `nativeButton` for a trigger: true when it renders a real `<button>`.
 * That is the default, an `asChild` child that is `<button>`, and an `asChild`
 * child component whose name ends in `Button` (`Button`, `SidebarMenuButton`,
 * ...) and does not itself slot into another element.
 */
export function nativeButtonFor(asChild: boolean | undefined, children: React.ReactNode): boolean {
  if (!asChild) return true;
  if (!React.isValidElement(children)) return false;
  if (typeof children.type === 'string') return children.type === 'button';
  return (
    /Button$/.test(componentName(children.type)) &&
    !(children.props as { asChild?: boolean }).asChild
  );
}

/**
 * `nativeButton` for a trigger, checked against the DOM. `nativeButtonFor`
 * guesses from the child's name, which a production build can minify away;
 * after mount this reads the rendered element's tag and corrects the guess.
 * Spread `ref` onto the Base UI part (compose it with the caller's ref).
 */
export function useNativeButton(asChild: boolean | undefined, children: React.ReactNode) {
  const guess = nativeButtonFor(asChild, children);
  const [actual, setActual] = React.useState<boolean | null>(null);
  const ref = React.useCallback(
    (node: HTMLElement | null) => {
      if (!node || !asChild) return;
      const isButton = node.tagName === 'BUTTON';
      setActual((current) => (current === isButton ? current : isButton));
    },
    [asChild],
  );
  return { nativeButton: actual ?? guess, ref };
}

/** The name of a component, through `forwardRef` and `memo` wrappers. */
function componentName(type: unknown): string {
  const t = type as {
    displayName?: string;
    name?: string;
    render?: unknown;
    type?: unknown;
  } | null;
  if (!t) return '';
  return (
    t.displayName ??
    t.name ??
    (t.render ? componentName(t.render) : t.type ? componentName(t.type) : '')
  );
}

/**
 * Marks a Base UI `Positioner` as a floating layer (the role Radix's
 * `data-radix-popper-content-wrapper` played). `lib/z-stack.tsx`, the desktop
 * titlebar CSS and outside-click guards match `[data-kortix-floating]`.
 */
export const FLOATING_LAYER_ATTR = { 'data-kortix-floating': '' } as const;

/* ---------- positioning ---------- */

export interface LegacyPositionProps {
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  sideOffset?: number;
  alignOffset?: number;
  collisionPadding?: number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>;
  avoidCollisions?: boolean;
  sticky?: 'partial' | 'always';
  collisionBoundary?: Element | null | Array<Element | null>;
  arrowPadding?: number;
  hideWhenDetached?: boolean;
  updatePositionStrategy?: 'optimized' | 'always';
}

/** Splits Radix `Content` positioning props into Base UI `Positioner` props. */
export function splitPosition<P extends LegacyPositionProps>(props: P) {
  const {
    side,
    align,
    sideOffset,
    alignOffset,
    collisionPadding,
    avoidCollisions,
    sticky,
    collisionBoundary,
    arrowPadding,
    hideWhenDetached: _hideWhenDetached,
    updatePositionStrategy: _updatePositionStrategy,
    ...rest
  } = props;
  const positioner: AnyProps = { side, align, sideOffset, alignOffset, arrowPadding };
  if (collisionPadding !== undefined) positioner.collisionPadding = collisionPadding;
  if (collisionBoundary) positioner.collisionBoundary = collisionBoundary;
  if (avoidCollisions === false) positioner.collisionAvoidance = { side: 'none', align: 'none' };
  if (sticky === 'always') positioner.sticky = true;
  for (const key of Object.keys(positioner))
    if (positioner[key] === undefined) delete positioner[key];
  return { positioner, rest };
}

/** Maps Base UI positioner variables to the `--radix-<name>-*` names consumers read. */
export function radixPositionVars(name: string): React.CSSProperties {
  return {
    [`--radix-${name}-content-available-height`]: 'var(--available-height)',
    [`--radix-${name}-content-available-width`]: 'var(--available-width)',
    [`--radix-${name}-content-transform-origin`]: 'var(--transform-origin)',
    [`--radix-${name}-trigger-width`]: 'var(--anchor-width)',
    [`--radix-${name}-trigger-height`]: 'var(--anchor-height)',
  } as React.CSSProperties;
}

/* ---------- Slot and VisuallyHidden ---------- */

/**
 * Renders its only child with these props merged in, the way Radix `Slot`
 * did: handlers chain, classes join, styles merge, refs compose.
 */
export const Slot = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement> & AnyProps>(
  ({ children, ...props }, ref) => {
    if (!React.isValidElement(children)) return null;
    const own = children.props as AnyProps;
    return React.cloneElement(children, mergeElementProps(own, { ...props, ref }));
  },
);
Slot.displayName = 'Slot';

/** Hides content visually and keeps it for screen readers. */
export const VisuallyHidden = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { asChild?: boolean }
>(({ asChild, className, ...props }, ref) => {
  const cls = className ? `sr-only ${className}` : 'sr-only';
  if (asChild) return <Slot ref={ref} className={cls} {...props} />;
  return <span ref={ref} className={cls} {...props} />;
});
VisuallyHidden.displayName = 'VisuallyHidden';

/* ---------- label re-entry ---------- */

/**
 * An `onClick` for a Base UI checkbox or radio root. Base UI forwards a
 * press to its hidden `<input>`; inside a consumer's `<label>`, that click
 * bubbles to the label. Browsers ignore it (the target is interactive
 * content), but happy-dom re-dispatches it to the button and loops. This
 * drops the re-entrant click; in a browser it never fires.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useLabelReentryGuard(onClick?: (event: any) => void) {
  const inClick = React.useRef(false);
  return React.useCallback(
    (event: React.MouseEvent<HTMLElement> & { preventBaseUIHandler?: () => void }) => {
      if (inClick.current) {
        event.preventBaseUIHandler?.();
        return;
      }
      inClick.current = true;
      queueMicrotask(() => {
        inClick.current = false;
      });
      onClick?.(event);
    },
    [onClick],
  );
}
