/**
 * Bounded promises: one module owns both deadline shapes, so a caller never
 * hand-rolls `Promise.race` against a timer.
 */

/**
 * Resolve with `fallback` when `p` does not settle within `ms`. The loser's
 * late rejection is swallowed so a timeout can never surface later as an
 * unhandled rejection. `F` is the deadline's failure shape — usually narrower
 * than the awaited result (a `{ message }` or `{ error }` the caller already
 * handles), so the resolved type is the union.
 */
export async function settleWithin<P, F = P>(
  p: Promise<P>,
  ms: number,
  fallback: () => F,
): Promise<P | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<P | F>((resolve) => {
    timer = setTimeout(() => resolve(fallback()), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}

/**
 * Reject with `message` when `p` does not settle within `ms`. The loser's
 * late rejection is swallowed so a timeout can never surface later as an
 * unhandled rejection.
 */
export async function rejectAfter<T>(
  p: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}
