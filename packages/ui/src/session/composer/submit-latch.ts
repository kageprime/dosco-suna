/**
 * Ignore duplicate submits from an already-cleared editor. A distinct draft
 * dispatches immediately, even while another upload or acceptance is pending.
 * The server inbox owns execution order; this guard must never hide a draft
 * behind a previous request. Dispatch clears the live editor synchronously.
 */
export function createSubmitLatch<Draft>(
  dispatch: (stashed?: Draft) => Promise<void>,
  /** Capture and clear a distinct draft, or return null for a double-fire. */
  captureDraft: () => Draft | null,
  /** True refuses this submit before anything is captured or cleared: the draft stays in the editor. */
  refuse: () => boolean = () => false,
): () => Promise<void> {
  let inFlight = 0;

  const run = async (draft?: Draft): Promise<void> => {
    inFlight += 1;
    try {
      await dispatch(draft);
    } finally {
      inFlight -= 1;
    }
  };

  return (): Promise<void> => {
    if (refuse()) return Promise.resolve();
    if (inFlight > 0) {
      const draft = captureDraft();
      return draft === null ? Promise.resolve() : run(draft);
    }
    return run();
  };
}
