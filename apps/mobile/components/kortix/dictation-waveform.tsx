/**
 * DictationWaveform — the composer's listening indicator. One bar
 * per microphone level sample (the recorder's metering, every 80 ms), newest
 * on the right, so the voice scrolls in from the right as it is heard. Older
 * bars fade out toward the left edge.
 *
 * Runs on the UI thread: `levels` is a shared value `useDictation` writes to,
 * so the composer never re-renders per sample. Until recording starts, and
 * while the clip is transcribed, the bars rest as dots at 40% opacity.
 */
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { DICTATION_BAR_COUNT } from '@/lib/session/dictation';

const BAR_WIDTH = 3;
const BAR_GAP = 3;
const MIN_HEIGHT = 3;
const MAX_HEIGHT = 24;
/** A little shorter than the sample interval (80 ms), so each bar settles before the next shift. */
const BAR_DURATION_MS = 70;
const BAR_EASING = Easing.out(Easing.quad);

function Bar({
  index,
  levels,
  reduceMotion,
}: {
  index: number;
  levels: SharedValue<number[]>;
  reduceMotion: boolean;
}) {
  // Oldest (left) 25% → newest (right) 100%.
  const opacity = 0.25 + (0.75 * index) / (DICTATION_BAR_COUNT - 1);
  const style = useAnimatedStyle(() => {
    const level = levels.value[index] ?? 0;
    const height = MIN_HEIGHT + (MAX_HEIGHT - MIN_HEIGHT) * level;
    return {
      height: reduceMotion
        ? height
        : withTiming(height, { duration: BAR_DURATION_MS, easing: BAR_EASING }),
    };
  });
  return (
    <Animated.View
      className="rounded-full bg-foreground"
      style={[{ width: BAR_WIDTH, opacity }, style]}
    />
  );
}

export function DictationWaveform({
  levels,
  listening,
}: {
  levels: SharedValue<number[]>;
  /** False while the recogniser is still starting: dots at 40%. */
  listening: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const restStyle = useAnimatedStyle(() => ({
    opacity: withTiming(listening ? 1 : 0.4, { duration: 160, easing: BAR_EASING }),
  }));
  return (
    <Animated.View
      className="flex-1 flex-row items-center justify-center"
      style={[{ gap: BAR_GAP, height: MAX_HEIGHT }, restStyle]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={listening ? 'Listening' : 'Not listening'}
      accessibilityLiveRegion="polite">
      {Array.from({ length: DICTATION_BAR_COUNT }, (_, i) => (
        <Bar key={i} index={i} levels={levels} reduceMotion={reduceMotion} />
      ))}
    </Animated.View>
  );
}
