/**
 * Where a tool row is drawn, and the card its expanded payload sits in.
 *
 * Mirrors apps/web `tool/shared/surface.tsx` + `ToolOutputCard` /
 * `ToolResultCard`:
 * - `ToolRowVariantContext` — a row inside a chain of thought
 *   uses `gap-3`, `text-sm leading-[1.5]`, and a 1.75rem card indent; every
 *   other surface keeps `gap-1.5` and 1.375rem. One context carries the gap
 *   and the indent together so they cannot drift apart (web `--tool-indent`).
 * - `useToolCardFrame` — `border bg-popover rounded-md border` spread into a
 *   card's style; `ToolResultCard` and the per-tool payload cards draw the
 *   `mt-1.5` seam, the row indent and the capped scrollable body around it.
 */

import {
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ScrollView, View, type ScrollViewProps } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { CaretRightIcon, CheckIcon, CopyIcon, type AppIcon } from '@/lib/icons';
import { MOTION } from '@/lib/utils/theme';
import { TURN_SPACE, useTurnPalette } from './styles';

/**
 * A tool drawn in the activity sheet's detail view (`turn/activity-sheet.tsx`).
 * `body`: the tool the detail is about — `BasicTool` draws its body only, since
 * the sheet header already names it. `nested`: any tool row inside that body.
 * At both levels the sheet is the only vertical scroller: `ToolScroll` renders
 * uncapped, and cards sit flush (no row text column to indent to).
 */
export type ToolDetailLevel = 'body' | 'nested' | null;

export const ToolDetailContext = createContext<ToolDetailLevel>(null);

/**
 * A tool body's capped vertical scroll area. In the transcript it scrolls
 * inside `maxHeight`; in the activity sheet it renders at full height so the
 * sheet scrolls it (no nested vertical scroller).
 */
export function ToolScroll({
  maxHeight,
  style,
  contentContainerStyle,
  children,
  ...props
}: ScrollViewProps & {
  /** The transcript cap; `undefined` for a scroller that fills its parent. */
  maxHeight: number | undefined;
  children?: ReactNode;
}) {
  const detail = useContext(ToolDetailContext);
  if (detail) return <View style={[style, contentContainerStyle]}>{children}</View>;
  return (
    <ScrollView
      bounces={false}
      overScrollMode="never"
      nestedScrollEnabled
      {...props}
      style={[{ maxHeight }, style]}
      contentContainerStyle={contentContainerStyle}
    >
      {children}
    </ScrollView>
  );
}

interface ToolRowVariant {
  /** The row is a step in a chain of thought. */
  chain: boolean;
  /** A bare step hides the tool's leading icon (never the outcome mark). */
  hideIcon: boolean;
}

export const ToolRowVariantContext = createContext<ToolRowVariant>({ chain: false, hideIcon: false });

export function useToolRowVariant(): ToolRowVariant {
  return useContext(ToolRowVariantContext);
}

/** Web `TOOL_INDENT` default: `--tool-indent` 1.375rem (22px). */
export const TOOL_INDENT = TURN_SPACE.toolIndent;

/**
 * Left offset of a card under a tool row: the row's text column. Web returns a
 * class (`ml-[var(--tool-indent)]` or `''`); mobile returns points (`0` on the
 * panel surface). Pair it with the `mt-1.5` seam web gates on the same value:
 * `{ marginLeft: indent, marginTop: indent ? TURN_SPACE.gap1_5 : 0 }`.
 */
export function useToolIndent(): number {
  const detail = useContext(ToolDetailContext);
  const { chain } = useToolRowVariant();
  if (detail) return 0;
  return chain ? TURN_SPACE.toolIndentChain : TURN_SPACE.toolIndent;
}

interface ToolCardFrameStyle {
  borderWidth: number;
  borderColor: string;
  backgroundColor: string;
  borderRadius: number;
}

/** Web `useToolCardFrame`: `border-border bg-popover rounded-md border`. Spread the result into a style. */
export function useToolCardFrame(): ToolCardFrameStyle {
  const palette = useTurnPalette();
  return {
    borderWidth: 1,
    borderColor: palette.border,
    backgroundColor: palette.popover,
    borderRadius: TURN_SPACE.radiusMd,
  };
}

/** Web `useToolCardPad`: `p-3`. */
export function useToolCardPad(): number {
  return TURN_SPACE.cardPad;
}

export function ToolCopyButton({ text }: { text: string }) {
  const palette = useTurnPalette();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onPress = useCallback(() => {
    void Clipboard.setStringAsync(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <Button
      variant="ghost"
      size="icon"
      accessibilityLabel={copied ? 'Copied' : 'Copy output'}
      onPress={onPress}
      style={{ position: 'absolute', top: TURN_SPACE.copyInset, right: TURN_SPACE.copyInset, zIndex: 10 }}
    >
      <Icon
        as={copied ? CheckIcon : CopyIcon}
        size={TURN_SPACE.icon}
        color={copied ? palette.success : palette.muted60}
      />
    </Button>
  );
}

/** Tailwind `transition-transform` default: 150ms, cubic-bezier(0.4, 0, 0.2, 1). */
const TOOL_CARET_TIMING = { duration: MOTION.duration.normal, easing: Easing.bezier(...MOTION.easing.inOut) };

/**
 * The disclosure mark every tool fold uses (web `CaretRightIcon` +
 * `transition-transform`, `rotate-90` when open), at any size — `size-3` in
 * `FoldedSection` / `StructuredOutput`, `size-3.5` in `ToolListRow`.
 */
export function ToolCaret({ open, color, size }: { open: boolean; color: string; size: number }) {
  const rotation = useSharedValue(open ? 90 : 0);
  useEffect(() => {
    rotation.value = withTiming(open ? 90 : 0, TOOL_CARET_TIMING);
  }, [open, rotation]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={[{ flexShrink: 0 }, style]}>
      <CaretRightIcon size={size} color={color} />
    </Animated.View>
  );
}

/**
 * An icon passed as a value. Web renderers pass a node (`icon={<GlobeIcon />}`);
 * mobile rows take an `AppIcon` component so the row can size and tint it. A
 * node is rendered as given.
 */
export type ToolIcon = AppIcon | ReactElement;

export function ToolIconSlot({ icon, size, color }: { icon: ToolIcon | undefined; size: number; color: string }) {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Glyph = icon as AppIcon;
  return <Glyph size={size} color={color} />;
}
