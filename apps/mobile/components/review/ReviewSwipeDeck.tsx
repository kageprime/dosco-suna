/**
 * ReviewSwipeDeck — the Review page's Needs you items, one card at a time
 * (web parity: `packages/ui/src/workspace/review/review-swipe-deck.tsx`).
 *
 * The layout follows the dating-app deck: the card fills the page between the
 * header and the segment bar, the whole review scrolls inside it (details,
 * body, files), and the round actions float over its bottom edge with no
 * captions. Swipe right for the item's yes (Merge, Approve), left for its no
 * (Close, Deny, Dismiss). Skip moves the card to the back; the expand control
 * opens `ReviewDetailSheet` (a file's diff, the session link).
 *
 * A decision has no swipe: its options in the card answer it. Every verdict
 * waits `UNDO_MS` behind an Undo toast before `onDecide` sends it, so a swipe
 * replaces the confirm dialog the sheet shows for a merge or a connector
 * call. Unmounting the deck sends what waits.
 */
import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, ScrollView } from 'react-native-gesture-handler';
import { LinearGradient } from 'expo-linear-gradient';
import Reanimated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useColorScheme } from 'nativewind';
import type { ReviewItem, ReviewVerdict } from '@kortix/sdk';

import { GlassButtons, LIQUID_GLASS_AVAILABLE } from '@/components/kortix/liquid-glass';
import { SurfaceContext } from '@/components/kortix/surface-context';
import { useToast } from '@/components/kortix/toast-provider';
import { DetailRows } from '@/components/review/ReviewDetailSheet';
import { ReviewBody } from '@/components/review/ReviewItemBody';
import { REVIEW_KIND_ICONS } from '@/components/review/review-icons';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { haptics } from '@/lib/haptics';
import {
  ArrowBendUpLeftIcon,
  ArrowCounterClockwiseIcon,
  ArrowsOutSimpleIcon,
  CheckIcon,
  WarningIcon,
  XIcon,
} from '@/lib/icons';
import { useChangeRequestDiff, useChangeRequestMergePreview } from '@/lib/projects/hooks';
import { reviewDetailRows } from '@/lib/review/review-detail';
import { formatReviewAge, reviewItemTone, reviewKindLabel, reviewVerdictLabel } from '@/lib/review/review-meta';
import { reviewSwipeVerdicts } from '@/lib/review/review-swipe';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** How long a verdict waits for Undo before it is sent. */
const UNDO_MS = 5_000;
/** The share of the card's width a release must pass to decide it. */
const SWIPE_SHARE = 0.28;
/** A flick this fast (pt/s) decides it at any distance. */
const FLICK_VELOCITY = 900;
/** The fly-off after a decision. */
const EXIT_MS = 240;
const EXIT_EASING = Easing.bezier(0.23, 1, 0.32, 1);
const RETURN_SPRING = { stiffness: 650, damping: 40, mass: 0.85 };
/** The cards drawn under the top one. */
const STACK_DEPTH = 2;
/** The floating action row: its height and its gap to the card's bottom edge. */
const ACTIONS_HEIGHT = 56;
const ACTIONS_BOTTOM = 16;
/** The card's corner radius: the phone's own, near enough. */
const CARD_RADIUS = 28;

type Direction = 'left' | 'right';

interface Staged {
  item: ReviewItem;
  verdict: ReviewVerdict;
  text?: string;
  timer: ReturnType<typeof setTimeout>;
}

interface ReviewSwipeDeckProps {
  projectId: string;
  /** The Needs you items, in list order. */
  items: ReviewItem[];
  /** Whether this viewer may give `verdict` on `item` (KRTX-1720). */
  allows: (item: ReviewItem, verdict: ReviewVerdict) => boolean;
  /**
   * Sends a verdict. Runs after the Undo window. `text`: a decision's answer
   * or what should change. The card stays hidden until the promise settles.
   */
  onDecide: (item: ReviewItem, verdict: ReviewVerdict, text?: string) => Promise<unknown> | void;
  /** Opens one item's detail sheet. */
  onOpen: (item: ReviewItem) => void;
  /** A left swipe on a change or an output: the sheet asks what should change. */
  onSendBack: (item: ReviewItem) => void;
  /** Bottom inset: the pinned segment bar covers this much of the page. */
  bottomInset: number;
}

interface CardHandle {
  fling: (dir: Direction, then: () => void) => void;
}

export function ReviewSwipeDeck({
  projectId,
  items,
  allows,
  onDecide,
  onOpen,
  onSendBack,
  bottomInset,
}: ReviewSwipeDeckProps) {
  const toast = useToast();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const accent = THEME.accent[isDark ? 'dark' : 'light'];
  const [skipped, setSkipped] = React.useState<string[]>([]);
  const [staged, setStaged] = React.useState<ReadonlyMap<string, Staged>>(() => new Map());
  // Verdicts sent and not yet settled: the list still holds the item until
  // the request lands, so the deck keeps hiding it.
  const [sending, setSending] = React.useState<ReadonlySet<string>>(() => new Set());
  const stagedRef = React.useRef(staged);
  stagedRef.current = staged;
  const onDecideRef = React.useRef(onDecide);
  onDecideRef.current = onDecide;
  // A verdict accepted while its card still flies off: registered at once,
  // so leaving the page mid-animation still sends it.
  const flyingRef = React.useRef<{ item: ReviewItem; verdict: ReviewVerdict; text?: string } | null>(null);
  const cardRef = React.useRef<CardHandle>(null);
  // A drag's progress toward a decision, 0..1: the card under it grows into place.
  const progress = useSharedValue(0);

  // Leaving the page sends what waits: Undo is a short grace, not a draft.
  React.useEffect(
    () => () => {
      const flying = flyingRef.current;
      // Consumed here: a fly-off completion queued before the unmount finds
      // no flight and sends nothing twice.
      flyingRef.current = null;
      if (flying) onDecideRef.current(flying.item, flying.verdict, flying.text);
      for (const entry of stagedRef.current.values()) {
        clearTimeout(entry.timer);
        onDecideRef.current(entry.item, entry.verdict, entry.text);
      }
    },
    [],
  );

  // Skipped cards go to the back, in the order they were skipped.
  const deck = React.useMemo(() => {
    const open = items.filter((item) => !staged.has(item.id) && !sending.has(item.id));
    const rank = (id: string) => skipped.indexOf(id);
    return [...open].sort((a, b) => rank(a.id) - rank(b.id));
  }, [items, staged, sending, skipped]);

  const top = deck[0] ?? null;
  const swipe = top ? reviewSwipeVerdicts(top.kind) : null;
  const yes = top && swipe?.right && allows(top, swipe.right) ? swipe.right : null;
  const no = top && swipe?.left && allows(top, swipe.left) ? swipe.left : null;

  const unstage = React.useCallback((id: string) => {
    setStaged((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const stage = React.useCallback(
    (item: ReviewItem, verdict: ReviewVerdict, text?: string) => {
      flyingRef.current = null;
      progress.value = 0;
      // One timer per item: a second stage replaces the first, never runs beside it.
      const previous = stagedRef.current.get(item.id);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => {
        setSending((prev) => new Set(prev).add(item.id));
        unstage(item.id);
        void Promise.resolve(onDecideRef.current(item, verdict, text)).finally(() =>
          setSending((prev) => {
            const next = new Set(prev);
            next.delete(item.id);
            return next;
          }),
        );
      }, UNDO_MS);
      setStaged((prev) => new Map(prev).set(item.id, { item, verdict, text, timer }));
      toast.info(`${reviewVerdictLabel(item.kind, verdict)}: ${item.title}`, {
        duration: UNDO_MS,
        action: {
          label: 'Undo',
          kind: 'undo',
          onPress: () => {
            const entry = stagedRef.current.get(item.id);
            if (!entry) return;
            clearTimeout(entry.timer);
            unstage(item.id);
            // The card comes back on top.
            setSkipped((prev) => prev.filter((id) => id !== item.id));
            haptics.tap();
          },
        },
      });
    },
    [progress, toast, unstage],
  );

  /** Registers the verdict of a card that starts to leave. False while one already flies. */
  const accept = React.useCallback((item: ReviewItem, dir: Direction) => {
    if (flyingRef.current) return false;
    const sides = reviewSwipeVerdicts(item.kind);
    const verdict = dir === 'right' ? sides.right : sides.left;
    if (!verdict) return false;
    flyingRef.current = { item, verdict };
    return true;
  }, []);

  /**
   * Stages the pending flight of `itemId` exactly once. The fly-off's end and
   * the top-change effect below can both call it; only the first finds the
   * flight (stage() clears it).
   */
  const land = React.useCallback(
    (itemId: string) => {
      const flying = flyingRef.current;
      if (!flying || flying.item.id !== itemId) return;
      stage(flying.item, flying.verdict, flying.text);
    },
    [stage],
  );

  const swiped = React.useCallback((item: ReviewItem) => land(item.id), [land]);

  // The flying card left the top before its fly-off finished (a poll, an
  // Undo of another card): its animation is gone with it, so its verdict
  // enters the Undo window now instead of waiting for an end that never comes.
  const topId = top?.id;
  React.useEffect(() => {
    const flying = flyingRef.current;
    if (flying && flying.item.id !== topId) land(flying.item.id);
  }, [topId, land]);

  const skip = React.useCallback(() => {
    if (!top || deck.length < 2 || flyingRef.current) return;
    haptics.selection();
    setSkipped((prev) => [...prev.filter((id) => id !== top.id), top.id]);
  }, [top, deck.length]);

  if (!top) {
    return (
      <View className="flex-1 items-center justify-center gap-1 px-6" style={{ paddingBottom: bottomInset }}>
        <Text className="font-roobert-medium text-lg text-foreground">You are all caught up</Text>
        <Text variant="muted">Nothing needs you right now</Text>
      </View>
    );
  }

  const below = deck.slice(1, 1 + STACK_DEPTH);

  return (
    <View className="flex-1 px-3 pt-1" style={{ paddingBottom: bottomInset + 4 }}>
      <View className="flex-1">
        {below
          .map((item, index) => <UnderCard key={item.id} depth={index + 1} progress={progress} />)
          .reverse()}
        <SwipeCard
          key={top.id}
          ref={cardRef}
          projectId={projectId}
          item={top}
          yesLabel={yes ? reviewVerdictLabel(top.kind, yes) : null}
          noLabel={no ? reviewVerdictLabel(top.kind, no) : null}
          sendsBack={no === 'changes'}
          onSendBack={() => onSendBack(top)}
          canAnswer={allows(top, 'answer')}
          progress={progress}
          onAccepted={(dir) => void accept(top, dir)}
          onSwiped={() => swiped(top)}
          onAnswer={(text) => {
            if (flyingRef.current) return;
            flyingRef.current = { item: top, verdict: 'answer', text };
            cardRef.current?.fling('right', () => land(top.id));
          }}
          onOpen={() => {
            haptics.tap();
            onOpen(top);
          }}
        />

        {/* The actions float over the card's bottom edge, Tinder's row, each
            on its own iOS 26 Liquid Glass (an opaque circle elsewhere). */}
        <GlassButtons>
        <View
          pointerEvents="box-none"
          className="absolute inset-x-0 flex-row items-center justify-center gap-5"
          style={{ bottom: ACTIONS_BOTTOM, height: ACTIONS_HEIGHT }}>
          <RoundAction label="Skip" small disabled={deck.length < 2} onPress={skip}>
            <Icon as={ArrowCounterClockwiseIcon} size={18} className="text-foreground" />
          </RoundAction>
          <RoundAction
            label={no === 'changes' ? 'Send back' : no ? reviewVerdictLabel(top.kind, no) : 'No'}
            disabled={!no}
            onPress={() => {
              // Sending back needs the words: the sheet asks what should change.
              if (no === 'changes') {
                haptics.tap();
                onSendBack(top);
                return;
              }
              if (accept(top, 'left')) cardRef.current?.fling('left', () => swiped(top));
            }}>
            {no === 'changes' ? (
              <Icon as={ArrowBendUpLeftIcon} size={26} color={accent.orange} />
            ) : (
              <Icon as={XIcon} size={26} color={accent.red} />
            )}
          </RoundAction>
          <RoundAction
            label={yes ? reviewVerdictLabel(top.kind, yes) : 'Yes'}
            disabled={!yes}
            onPress={() => {
              if (accept(top, 'right')) cardRef.current?.fling('right', () => swiped(top));
            }}>
            <Icon as={CheckIcon} size={26} color={accent.green} />
          </RoundAction>
          <RoundAction
            label="Open details"
            small
            onPress={() => {
              haptics.tap();
              onOpen(top);
            }}>
            <Icon as={ArrowsOutSimpleIcon} size={18} className="text-foreground" />
          </RoundAction>
        </View>
        </GlassButtons>
      </View>
    </View>
  );
}

/** A round action over the card: an icon with no caption, its name for a screen reader. */
function RoundAction({
  label,
  small,
  disabled,
  onPress,
  children,
}: {
  label: string;
  small?: boolean;
  disabled?: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      // On glass the material is the fill; elsewhere a raised opaque circle.
      variant={LIQUID_GLASS_AVAILABLE ? 'ghost' : 'secondary'}
      size={small ? 'icon-lg' : 'icon-xl'}
      className="rounded-full"
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={label}
      style={
        LIQUID_GLASS_AVAILABLE
          ? undefined
          : {
              shadowColor: '#000',
              shadowOpacity: 0.12,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 4 },
              elevation: 4,
            }
      }>
      {children}
    </Button>
  );
}

/** A card under the top one: smaller and lower, growing into place as the top one leaves. */
function UnderCard({ depth, progress }: { depth: number; progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const step = depth - progress.value;
    return {
      opacity: 1 - step * 0.35,
      transform: [{ translateY: step * 10 }, { scale: 1 - step * 0.035 }],
    };
  });
  return (
    <Reanimated.View
      pointerEvents="none"
      className="absolute inset-0 bg-card dark:bg-popover"
      style={[{ borderRadius: CARD_RADIUS }, style]}
    />
  );
}

const SwipeCard = React.forwardRef<
  CardHandle,
  {
    projectId: string;
    item: ReviewItem;
    yesLabel: string | null;
    noLabel: string | null;
    canAnswer: boolean;
    progress: SharedValue<number>;
    /** A swipe passed the threshold: the verdict is decided, the card still flies. */
    onAccepted: (dir: Direction) => void;
    /** Left means "send it back": the card returns and the sheet asks what should change. */
    sendsBack: boolean;
    onSendBack: () => void;
    onSwiped: (dir: Direction) => void;
    onAnswer: (text: string | undefined) => void;
    onOpen: () => void;
  }
>(function SwipeCard(
  { projectId, item, yesLabel, noLabel, sendsBack, onSendBack, canAnswer, progress, onAccepted, onSwiped, onAnswer, onOpen },
  ref,
) {
  const { width } = useWindowDimensions();
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const reduced = useReducedMotion();
  const tx = useSharedValue(0);
  const gone = useSharedValue(0);
  // Set once a verdict is accepted: the card is leaving, and a second drag
  // or press must not cancel the fly-off (and with it the Undo window).
  const flying = useSharedValue(false);
  const canRight = !!yesLabel;
  const canLeft = !!noLabel;
  const threshold = width * SWIPE_SHARE;
  const off = width * 1.3;

  const fling = React.useCallback(
    (dir: Direction, then: () => void) => {
      if (flying.value) return;
      flying.value = true;
      haptics.medium();
      if (reduced) {
        gone.value = withTiming(1, { duration: EXIT_MS }, (finished) => {
          if (finished) scheduleOnRN(then);
        });
        return;
      }
      tx.value = withTiming(dir === 'right' ? off : -off, { duration: EXIT_MS, easing: EXIT_EASING }, (finished) => {
        if (finished) scheduleOnRN(then);
      });
      progress.value = withTiming(1, { duration: EXIT_MS, easing: EXIT_EASING });
    },
    [off, reduced, tx, gone, progress, flying],
  );
  React.useImperativeHandle(ref, () => ({ fling }), [fling]);

  const crossed = useSharedValue(false);
  // Horizontal only: a vertical move fails the pan, so the card's own scroll wins.
  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((e) => {
      'worklet';
      if (flying.value) return;
      const dx = e.translationX;
      // A side with no verdict resists: the card moves a third as far.
      const blocked = (dx > 0 && !canRight) || (dx < 0 && !canLeft);
      tx.value = blocked ? dx / 3 : dx;
      progress.value = blocked ? 0 : Math.min(1, Math.abs(dx) / threshold);
      const past = !blocked && Math.abs(dx) > threshold;
      if (past !== crossed.value) {
        crossed.value = past;
        scheduleOnRN(haptics.selection);
      }
    })
    .onEnd((e) => {
      'worklet';
      if (flying.value) return;
      const dx = tx.value;
      const right = canRight && dx > 0 && (dx > threshold || e.velocityX > FLICK_VELOCITY);
      const left = canLeft && dx < 0 && (dx < -threshold || e.velocityX < -FLICK_VELOCITY);
      crossed.value = false;
      if (left && sendsBack) {
        // The card comes back; the sheet asks what should change.
        tx.value = withSpring(0, { ...RETURN_SPRING, velocity: e.velocityX });
        progress.value = withTiming(0, { duration: 160 });
        scheduleOnRN(onSendBack);
        return;
      }
      if (right || left) {
        const dir: Direction = right ? 'right' : 'left';
        flying.value = true;
        scheduleOnRN(onAccepted, dir);
        scheduleOnRN(haptics.medium);
        tx.value = withTiming(right ? off : -off, { duration: EXIT_MS, easing: EXIT_EASING }, (finished) => {
          if (finished) scheduleOnRN(onSwiped, dir);
        });
        progress.value = withTiming(1, { duration: EXIT_MS });
        return;
      }
      tx.value = withSpring(0, { ...RETURN_SPRING, velocity: e.velocityX });
      progress.value = withTiming(0, { duration: 160 });
    });

  const cardStyle = useAnimatedStyle(() => ({
    opacity: 1 - gone.value,
    transform: [
      { translateX: tx.value },
      { rotate: `${interpolate(tx.value, [-width, 0, width], [-12, 0, 12])}deg` },
    ],
  }));
  const yesStyle = useAnimatedStyle(() => ({
    opacity: canRight ? interpolate(tx.value, [0, threshold], [0, 1], 'clamp') : 0,
  }));
  const noStyle = useAnimatedStyle(() => ({
    opacity: canLeft ? interpolate(tx.value, [-threshold, 0], [1, 0], 'clamp') : 0,
  }));

  // The card's fill: grey `card` on the white light page, `popover` (7.8%)
  // on the 4.3% dark page, so it stands off the page in both themes. Its
  // Details group draws on the sheet surface, a shade under the card.
  const cardColor = isDark ? THEME.dark.popover : THEME.light.card;

  return (
    <GestureDetector gesture={pan}>
      <Reanimated.View
        className="absolute inset-0 overflow-hidden bg-card dark:bg-popover"
        style={[
          {
            borderRadius: CARD_RADIUS,
            shadowColor: '#000',
            shadowOpacity: isDark ? 0 : 0.1,
            shadowRadius: 18,
            shadowOffset: { width: 0, height: 6 },
            elevation: 6,
          },
          cardStyle,
        ]}
        accessibilityActions={[
          ...(canRight ? [{ name: 'yes', label: yesLabel ?? '' }] : []),
          ...(canLeft ? [{ name: 'no', label: noLabel ?? '' }] : []),
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'yes') {
            onAccepted('right');
            fling('right', () => onSwiped('right'));
          } else if (event.nativeEvent.actionName === 'no' && sendsBack) {
            onSendBack();
          } else if (event.nativeEvent.actionName === 'no') {
            onAccepted('left');
            fling('left', () => onSwiped('left'));
          }
        }}>
        <SurfaceContext.Provider value="sheet">
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: ACTIONS_HEIGHT + ACTIONS_BOTTOM * 2 + 16 }}>
            <CardContent
              projectId={projectId}
              item={item}
              isDark={isDark}
              canAnswer={canAnswer}
              onAnswer={onAnswer}
              onOpen={onOpen}
            />
          </ScrollView>
        </SurfaceContext.Provider>

        {/* The content fades out under the floating actions. */}
        <LinearGradient
          pointerEvents="none"
          colors={[withAlpha(cardColor, 0), cardColor]}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: ACTIONS_HEIGHT + ACTIONS_BOTTOM * 2 + 24 }}
        />

        {/* The verdict a release gives: the card takes its colour, green
            for yes, red for no, deeper as the drag nears the decision. */}
        {yesLabel ? <Tint tone="green" style={yesStyle} /> : null}
        {noLabel ? <Tint tone={sendsBack ? 'orange' : 'red'} style={noStyle} /> : null}

        <View className="absolute right-3 top-3">
          <GlassButtons>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onPress={onOpen}
              accessibilityLabel="Open details">
              <Icon as={ArrowsOutSimpleIcon} size={18} className="text-foreground" />
            </Button>
          </GlassButtons>
        </View>
      </Reanimated.View>
    </GestureDetector>
  );
});

/** A wash of the verdict's colour over the whole card. */
function Tint({ tone, style }: { tone: 'green' | 'red' | 'orange'; style: ReturnType<typeof useAnimatedStyle> }) {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const color = THEME.accent[isDark ? 'dark' : 'light'][tone];
  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: withAlpha(color, isDark ? 0.22 : 0.14) },
        style,
      ]}
    />
  );
}

/** The whole review in the card: who and what, the details, then the kind's body. */
function CardContent({
  projectId,
  item,
  isDark,
  canAnswer,
  onAnswer,
  onOpen,
}: {
  projectId: string;
  item: ReviewItem;
  isDark: boolean;
  canAnswer: boolean;
  onAnswer: (text: string | undefined) => void;
  onOpen: () => void;
}) {
  const accent = THEME.accent[isDark ? 'dark' : 'light'];
  const tone = reviewItemTone(item.kind, item.status);
  const tint = tone === 'muted' ? THEME[isDark ? 'dark' : 'light'].mutedForeground : accent[tone];
  // A change's diff and merge preview, as the detail sheet reads them (cached).
  const crId = item.kind === 'change' ? (item.detail.crId ?? null) : null;
  const diffQuery = useChangeRequestDiff(projectId, crId);
  const previewQuery = useChangeRequestMergePreview(projectId, crId, true);
  const rows = React.useMemo(
    () => reviewDetailRows(item, { diff: diffQuery.data, preview: previewQuery.data }),
    [item, diffQuery.data, previewQuery.data],
  );
  const kind =
    reviewKindLabel(item.kind) + (item.kind === 'change' && item.detail.number != null ? ` #${item.detail.number}` : '');
  const meta = [item.agent, formatReviewAge(item.createdAt)].filter(Boolean).join(' · ');

  return (
    <View className="gap-6 pt-5">
      <View className="gap-4 px-5">
        <View className="flex-row items-center gap-3 pr-10">
          <View
            className="size-11 items-center justify-center rounded-2xl"
            style={{ backgroundColor: withAlpha(tint, 0.14) }}>
            <Icon as={REVIEW_KIND_ICONS[item.kind]} size={22} color={tint} />
          </View>
          <View className="flex-1">
            <Text className="font-roobert-medium text-[15px] text-foreground" numberOfLines={1}>
              {kind}
            </Text>
            <Text variant="muted" className="text-[13px]" numberOfLines={1}>
              {meta}
            </Text>
          </View>
        </View>

        <View className="gap-2">
          <Text className="font-roobert-medium text-[26px] leading-8 tracking-tight text-foreground">
            {item.title}
          </Text>
          {item.summary ? <Text className="text-base leading-6 text-muted-foreground">{item.summary}</Text> : null}
          {item.risk === 'high' ? (
            <View className="flex-row items-center gap-1.5 pt-1">
              <Icon as={WarningIcon} size={16} color={accent.orange} />
              <Text variant="muted" className="text-[13px]">
                High risk
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      <View className="gap-6 px-3">
        <DetailRows rows={rows} />
        <ReviewBody
          projectId={projectId}
          item={item}
          onAnswer={(_item, _verdict, text) => onAnswer(text)}
          actionable={canAnswer}
          diff={diffQuery.data}
          diffLoading={diffQuery.isLoading}
          diffFailed={diffQuery.isError}
          onRetryDiff={() => void diffQuery.refetch()}
          // A file's diff reads in the detail sheet.
          onOpenFile={onOpen}
          isDark={isDark}
        />
      </View>
    </View>
  );
}
