/**
 * SessionStatusMark — the status glyph before a session title, in the project
 * sidebar and on the Sessions page. A port of web's `SessionStatusMark`
 * (`packages/ui/src/session/list/session-status-mark.tsx`): the same 16pt
 * geometry, shapes and colour rule.
 *
 * Colour says who acts: grey nobody, green the agent, blue you, red broken.
 * Each state differs in shape as well, so colour is never the only cue:
 *
 *   running    green half arc leading a fading trail of dashes; still, as
 *              on web (many rows can be working at once)
 *   done       green ring of 8 dots around a filled core (idle, ready)
 *   needs-you  blue question mark (an agent question or approval holds the
 *              agent) or blue diff glyph (output waits for review)
 *   failed     red ring around a filled core
 *   starting   grey ring: a wake is meant to be instant, so it has no state
 *   stopped    grey ring
 *   legacy     grey counter-clockwise clock (a migrated session that has not run)
 *
 * `statusMarkGlyph` is the mapping, tested in `lib/session/status-mark.test.ts`.
 * The mark sits in a 20pt slot (`h-5 min-w-5`), so every row's title starts
 * on one edge. It is hidden from screen readers: the row's label speaks the
 * status (`sessionStatusLabel`).
 */

import * as React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useColorScheme } from 'nativewind';

import { Icon } from '@/components/ui/icon';
import { ClockCounterClockwiseIcon, GitDiffIcon, QuestionIcon } from '@/lib/icons';
import type { SessionDisplayStatus } from '@/lib/session/session-list';
import type { NeedsYouWaitingOn } from '@/lib/session/needs-you';
import { statusMarkGlyph, type StatusMarkTone } from '@/lib/session/status-mark';
import { THEME } from '@/lib/utils/theme';

/** Glyph box, as on web. */
const SIZE = 16;
/** The ring of the `done` glyph: 8 dots on radius 6 around the centre. */
const DOTS = Array.from({ length: 8 }, (_, i) => {
  const angle = (i * 2 * Math.PI) / 8;
  return { cx: 8 + 6 * Math.sin(angle), cy: 8 - 6 * Math.cos(angle) };
});

/** Behind the arc, clockwise: each dash fainter, so the glyph reads as turning. */
const WORKING_TRAIL = [
  { d: 'M2.84 4.39 A6.3 6.3 0 0 1 4.39 2.84', opacity: 0.85 },
  { d: 'M1.8 9.1 A6.3 6.3 0 0 1 1.8 6.9', opacity: 0.55 },
  { d: 'M4.39 13.16 A6.3 6.3 0 0 1 2.84 11.61', opacity: 0.25 },
];

function useToneColor(tone: StatusMarkTone): string {
  const { colorScheme } = useColorScheme();
  switch (tone) {
    case 'green':
      return THEME.accent.green;
    case 'blue':
      return THEME.accent.blue;
    case 'red':
      return THEME.accent.red;
    case 'muted':
    default:
      return (colorScheme === 'dark' ? THEME.dark : THEME.light).mutedForeground;
  }
}

function ReadyGlyph({ color }: { color: string }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16">
      {DOTS.map((dot, i) => (
        <Circle key={i} cx={dot.cx} cy={dot.cy} r={1} fill={color} />
      ))}
      <Circle cx={8} cy={8} r={3.6} fill={color} />
    </Svg>
  );
}

/** Still, as on web: many rows can be working at once, so nothing animates.
 *  The fading trail behind the arc reads as turning. */
function WorkingGlyph({ color }: { color: string }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16" fill="none">
        {WORKING_TRAIL.map((dash) => (
          <Path
            key={dash.d}
            d={dash.d}
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeOpacity={dash.opacity}
          />
        ))}
        <Path d="M8 1.7 A6.3 6.3 0 0 1 8 14.3" stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </Svg>
  );
}

function RingGlyph({ color, core }: { color: string; core: boolean }) {
  return (
    <Svg width={SIZE} height={SIZE} viewBox="0 0 16 16">
      <Circle cx={8} cy={8} r={6.3} stroke={color} strokeWidth={1.5} fill="none" />
      {core ? <Circle cx={8} cy={8} r={4} fill={color} /> : null}
    </Svg>
  );
}

/** A 20pt slot (`h-5 min-w-5`) holding the glyph for `status`. */
export function SessionStatusMark({
  status,
  waitingOn = 'review',
}: {
  status: SessionDisplayStatus;
  /** `needs-you` only: what the wait blocks (`SessionNeedsYou.waitingOn`). */
  waitingOn?: NeedsYouWaitingOn;
}) {
  const { glyph, tone } = statusMarkGlyph(status, waitingOn);
  const color = useToneColor(tone);
  let mark: React.ReactNode;
  switch (glyph) {
    case 'working':
      mark = <WorkingGlyph color={color} />;
      break;
    case 'ready':
      mark = <ReadyGlyph color={color} />;
      break;
    case 'question':
      mark = <Icon as={QuestionIcon} size={SIZE} color={color} />;
      break;
    case 'review':
      mark = <Icon as={GitDiffIcon} size={SIZE} color={color} />;
      break;
    case 'legacy':
      mark = <Icon as={ClockCounterClockwiseIcon} size={14} color={color} />;
      break;
    case 'ring-core':
      mark = <RingGlyph color={color} core />;
      break;
    case 'ring':
    default:
      mark = <RingGlyph color={color} core={false} />;
      break;
  }
  return (
    <View
      className="h-5 min-w-5 items-center justify-center"
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      {mark}
    </View>
  );
}
