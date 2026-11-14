/**
 * The iOS native sheet (UISheetPresentationController) behind
 * `KortixBottomSheetModal`: when it is used, and how gorhom's sheet props map
 * onto its detents.
 *
 * The native sheet is `FormSheet` from `react-native-screens/experimental`
 * (native component `RNSFormSheetHost`). Two conditions:
 * - iOS. Android keeps gorhom.
 * - The running binary registered `RNSFormSheetHost`. It is compiled only with
 *   `RNS_GAMMA_ENABLED=1` (`ios/Podfile`, set by expo-router), and
 *   `runtimeVersion` is a fixed string, so an OTA update can reach a binary
 *   built without it. That binary keeps gorhom.
 *
 * Native detents are fractions of the sheet's maximum height
 * (`UISheetPresentationControllerDetentResolutionContext.maximumDetentValue`),
 * strictly ascending, or the single value `'fitToContents'`. The native side
 * rejects `fitToContents` next to any other detent
 * (`RNSAreDetentsValid` in `RNSFormSheetDetentResolver.mm`): it falls back to
 * one large detent. So a content-sized sheet cannot also list a full detent.
 *
 * Pure (no React Native import), so bun test loads it.
 */

/** Use the native sheet: iOS and a binary that registered `RNSFormSheetHost`. */
export function supportsNativeSheet(os: string, hasFormSheetHost: boolean): boolean {
  return os === 'ios' && hasFormSheetHost;
}

/**
 * Whether the binary registered a Fabric component. Reads the JSI global that
 * React Native installs in every bridgeless runtime
 * (`RCTInstallNativeComponentRegistryBinding`, `RCTInstance.mm`): it asks the
 * `RCTComponentViewFactory`, which resolves the class from the codegen
 * component provider. A class the binary does not contain resolves to nil, so
 * the answer is false. No global (an old runtime, a test): false.
 */
export function hasNativeComponent(name: string, scope: unknown = globalThis): boolean {
  const probe = (scope as { __nativeComponentRegistry__hasComponent?: (n: string) => boolean })
    .__nativeComponentRegistry__hasComponent;
  if (typeof probe !== 'function') return false;
  try {
    return probe(name) === true;
  } catch {
    return false;
  }
}

/**
 * The native sheet's maximum detent height, estimated from the window: the
 * window less the top safe area, the bottom safe area (a detent's height
 * excludes it; the sheet extends under the home indicator by itself) and the
 * gap UIKit keeps above a full-height sheet. 16pt is a conservative gap: an
 * estimate smaller than the real value only makes a capped sheet a few points
 * shorter, an estimate larger would clip its last points.
 */
export function nativeSheetMaxHeight(windowHeight: number, topInset: number, bottomInset: number): number {
  return Math.max(0, windowHeight - topInset - bottomInset - 16);
}

/**
 * How many points of a fixed-detent sheet's content box lie below the screen
 * at the detent `fraction`.
 *
 * The box is sized from the sheet controller's view. At a partial detent that
 * view can keep the full detent's height while the sheet shows only its top:
 * the bottom of the box (a `PinnedBar`, the Agent · Model tabs) is then off
 * the screen. The visible sheet is `fraction` of the maximum detent plus the
 * bottom safe area; the rest is hidden.
 *
 * The box height tells the two layouts apart: a box near
 * `fraction × maxHeight + bottomInset` was already sized to the detent (0
 * hidden), a box near `maxHeight + bottomInset` was not. The hidden part
 * follows the measured box, not the estimate, so a small error in
 * `nativeSheetMaxHeight` does not move the result.
 */
export function nativeSheetHiddenBottom(input: {
  boxHeight: number;
  fraction: number;
  maxHeight: number;
  bottomInset: number;
}): number {
  const { boxHeight, fraction, maxHeight, bottomInset } = input;
  if (!(boxHeight > 0) || !(fraction > 0) || fraction >= 1) return 0;
  const sizedToDetent = fraction * maxHeight + bottomInset;
  const sizedToFull = maxHeight + bottomInset;
  if (Math.abs(boxHeight - sizedToDetent) <= Math.abs(boxHeight - sizedToFull)) return 0;
  return Math.round((1 - fraction) * Math.max(0, boxHeight - bottomInset));
}

/**
 * How many points of the content box lie below the screen, from the box's
 * frame in window coordinates (`measureInWindow` once the sheet rests). This
 * is the measured answer; `nativeSheetHiddenBottom` is the estimate used until
 * it arrives. TestFlight 1.6.2 (171): the estimate left the picker's
 * Agent · Model tabs below the screen at the 85% detent, so the box is not
 * sized the way the estimate assumes.
 */
export function nativeSheetBoxBelowScreen(input: { y: number; height: number; windowHeight: number }): number {
  const { y, height, windowHeight } = input;
  if (!Number.isFinite(y) || !(height > 0) || !(windowHeight > 0)) return 0;
  // Never hide the whole box: a sheet still off screen measures nothing useful.
  return Math.round(Math.min(Math.max(0, y + height - windowHeight), height / 2));
}

/** gorhom's `snapPoints`: `'50%'`, a number in points, or a Reanimated shared value. */
export type GorhomDetents = ReadonlyArray<string | number> | { value: unknown } | undefined;

export type NativeDetents = number[] | 'fitToContents';

/** One gorhom snap point as a fraction of the maximum height, or null when it cannot be read. */
export function detentFraction(point: string | number, maxHeight: number): number | null {
  let fraction: number;
  if (typeof point === 'number') {
    if (!(maxHeight > 0)) return null;
    fraction = point / maxHeight;
  } else {
    const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(point);
    if (!match) return null;
    fraction = Number(match[1]) / 100;
  }
  if (!Number.isFinite(fraction) || fraction <= 0) return null;
  // At or past the top (`'100%'`, a point value taller than the screen): full.
  return fraction >= 0.995 ? 1 : Math.round(fraction * 1000) / 1000;
}

/**
 * The native detents for a `KortixBottomSheetModal`, and the native index of
 * the detent it opens at.
 *
 * - A content-sized sheet (gorhom's dynamic sizing, the default, with no
 *   `snapPoints` or only `'100%'`) is marked `'fitToContents'`: the sheet is
 *   as tall as its content, up to the maximum height, and has no separate
 *   full detent. The marker never reaches the native side: `NativeSheet`
 *   measures the body and passes one custom detent (`contentDetent`).
 * - Every other sheet lists its `snapPoints` as fractions, plus `1` (full
 *   screen) at the end, the native form of `withFullDetent`. The call site's
 *   `index` keeps pointing at the detent it named.
 * - `fullDetent: false` drops the full detent, the added `1` and a listed
 *   `'100%'`: the sheet stops at its highest partial snap point. UIKit sizes a sheet's view to its largest detent, so at a
 *   partial detent the bottom of a full-height view lies below the screen. A
 *   sheet with a bar pinned to its bottom (the model sheet's Agent · Model
 *   tabs) lists only its own detent and its view ends at the visible edge.
 * - A shared value cannot be read on the JS thread: one full detent.
 */
export function resolveNativeDetents(input: {
  snapPoints: GorhomDetents;
  dynamicSizing: boolean;
  index?: number;
  maxHeight: number;
  /** `false`: no full detent after the snap points. Default `true`. */
  fullDetent?: boolean;
}): { detents: NativeDetents; initialIndex: number } {
  const { snapPoints, dynamicSizing, maxHeight, fullDetent = true } = input;
  if (snapPoints !== undefined && !Array.isArray(snapPoints)) return { detents: [1], initialIndex: 0 };
  const points = (snapPoints ?? []) as ReadonlyArray<string | number>;
  const fractions = points.map((point) => detentFraction(point, maxHeight));
  const partial = fractions.some((fraction) => fraction !== null && fraction < 1);
  if (dynamicSizing && !partial) return { detents: 'fitToContents', initialIndex: 0 };

  const listed = fractions.filter((f): f is number => f !== null);
  const partials = listed.filter((f) => f < 1);
  const kept = fullDetent || partials.length === 0 ? [...listed, 1] : partials;
  const sorted = [...new Set(kept)].sort((a, b) => a - b);
  const requested = fractions[input.index ?? 0] ?? null;
  const initialIndex = requested === null ? 0 : Math.max(0, sorted.indexOf(requested));
  return { detents: sorted, initialIndex };
}

/**
 * The detent of a content-sized sheet: its measured content as a fraction of
 * the maximum detent, rounded up so the last row is never cut. Content as tall
 * as the maximum, or taller, is the full detent (the body scrolls there).
 *
 * `NativeSheet` presents a content-sized sheet at this custom detent instead
 * of react-native-screens' `fitToContents`. `fitToContents` reads the content
 * height from a wrapper view that reports it only after it is mounted, and
 * the sheet mounts presented: UIKit resolved the detent at height 0, which
 * falls back to the maximum. Every content-sized sheet then stood at full
 * height, opaque and edge to edge on iOS 26 instead of the floating glass.
 */
export function contentDetent(contentHeight: number, maxHeight: number): number {
  if (!(contentHeight > 0) || !(maxHeight > 0)) return 1;
  const fraction = Math.ceil((contentHeight / maxHeight) * 1000) / 1000;
  return fraction >= 0.995 ? 1 : fraction;
}

/** How far the iOS 26 glass sheet floats in from each window edge below its full detent. */
export const FLOATING_SHEET_INSET = 8;

/**
 * The width a content-sized sheet's body is measured at before the sheet is
 * presented (the native host has no size yet): the window less the glass
 * sheet's side insets on iOS 26, the window before it. The body lays out at
 * the sheet's real width once it is presented.
 */
export function nativeSheetContentWidth(windowWidth: number, glass: boolean): number {
  return Math.max(0, windowWidth - (glass ? FLOATING_SHEET_INSET * 2 : 0));
}
