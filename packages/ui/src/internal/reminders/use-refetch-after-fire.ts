'use client';

import type { SessionReminder } from '@kortix/sdk';
import { useEffect } from 'react';
import { soonestFire } from './reminder-format';

/** The scheduler ticks every second; this is enough for the fire to land. */
const AFTER_FIRE_MS = 5_000;

/**
 * Refetch once, just after the soonest active reminder fires, so its "next"
 * time and state never sit stale on screen. No polling: one timer, re-armed
 * from each fresh list.
 */
export function useRefetchAfterFire(
  reminders: readonly Pick<SessionReminder, 'state' | 'next_fire_at'>[] | undefined,
  refetch: () => unknown,
) {
  const soonest = reminders ? soonestFire(reminders) : null;
  useEffect(() => {
    if (soonest === null) return;
    // setTimeout caps at ~24.8 days; a reminder further out re-arms on the next load.
    const wait = Math.min(Math.max(soonest - Date.now(), 0) + AFTER_FIRE_MS, 2_000_000_000);
    const timer = setTimeout(() => void refetch(), wait);
    return () => clearTimeout(timer);
  }, [soonest, refetch]);
}
