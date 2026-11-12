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
 *   `snapPoints` or only `'100%'`) is `'fitToContents'`: the sheet is as tall
 *   as its content, up to the maximum height. It has no separate full detent
 *   (see the module comment); its content is already fully visible, and a
 *   taller body scrolls inside the maximum height.
 * - Every other sheet lists its `snapPoints` as fractions, plus `1` (full
 *   screen) at the end, the native form of `withFullDetent`. The call site's
 *   `index` keeps pointing at the detent it named.
 * - A shared value cannot be read on the JS thread: one full detent.
 */
export function resolveNativeDetents(input: {
  snapPoints: GorhomDetents;
  dynamicSizing: boolean;
  index?: number;
  maxHeight: number;
}): { detents: NativeDetents; initialIndex: number } {
  const { snapPoints, dynamicSizing, maxHeight } = input;
  if (snapPoints !== undefined && !Array.isArray(snapPoints)) return { detents: [1], initialIndex: 0 };
  const points = (snapPoints ?? []) as ReadonlyArray<string | number>;
  const fractions = points.map((point) => detentFraction(point, maxHeight));
  const partial = fractions.some((fraction) => fraction !== null && fraction < 1);
  if (dynamicSizing && !partial) return { detents: 'fitToContents', initialIndex: 0 };

  const sorted = [...new Set([...fractions.filter((f): f is number => f !== null), 1])].sort((a, b) => a - b);
  const requested = fractions[input.index ?? 0] ?? null;
  const initialIndex = requested === null ? 0 : Math.max(0, sorted.indexOf(requested));
  return { detents: sorted, initialIndex };
}
