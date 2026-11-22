/**
 * Confirmed connection faults stay actionable. Routine sleep, wake and
 * connecting states are silent, matching web's sessionComposerReadiness.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { WarningCircleIcon as CircleAlert } from '@/lib/icons';
import { useSandboxContext } from '@/contexts/SandboxContext';
import { THEME } from '@/lib/utils/theme';
import { useTone } from '@/lib/utils/tone';
import { sessionConnectionLabel } from '@kortix/sdk';
import {
  useElapsedSince,
  useSandboxReachability,
} from '@/hooks/useSandboxReachability';
import { ComposerStatusAction, ComposerStatusPill } from './ComposerStatusPill';

interface SandboxHealthPillProps {
  /** Optional — opens a detailed health sheet. Hidden when omitted. */
  onHealth?: () => void;
  /** Rendered in this slot while the sandbox is reachable: the thread's
   *  "Live updates paused" pill (COR-144), so the two never stack. */
  whenReachable?: React.ReactNode;
}

export function SandboxHealthPill({ onHealth, whenReachable }: SandboxHealthPillProps) {
  const { sandboxUrl } = useSandboxContext();
  const { reachable, downSince, checked, connection } = useSandboxReachability(sandboxUrl);
  const elapsed = useElapsedSince(downSince);
  const wording = sessionConnectionLabel(connection);
  const faulted = wording?.tone === 'danger';
  const dotColor = THEME.accent[useTone()].orange;

  const show = checked && !reachable && faulted;

  // Amber dot ping animation (mirrors `animate-ping` on web).
  const pingAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!show) return;
    const loop = Animated.loop(
      Animated.timing(pingAnim, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [show, pingAnim]);

  if (!show) return reachable && whenReachable ? <>{whenReachable}</> : null;

  const pingScale = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] });
  const pingOpacity = pingAnim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] });

  return (
    <ComposerStatusPill
      dotColor={dotColor}
      ping={{ scale: pingScale, opacity: pingOpacity }}
      label={wording?.label}
      elapsed={elapsed}
      actions={faulted && onHealth ? <ComposerStatusAction icon={CircleAlert} label="Health" onPress={onHealth} /> : null}
    />
  );
}
