'use client';

import { useEffect, useState } from 'react';

/**
 * The current time, ticking every `intervalMs` (1 s default) while `active`:
 * a live run's elapsed labels tick, relative labels ("in 12 min") stay
 * current. An inactive clock renders once and never starts a timer.
 */
export function useNow(intervalMs = 1_000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
