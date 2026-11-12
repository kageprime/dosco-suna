import { useEffect, useState } from 'react';

/**
 * How long the open text block may go without growing before the busy row
 * returns. Text deltas arrive well under a second apart. A longer silence
 * means the model moved on: the harness shows a tool call only once it runs
 * (`tool_execution_start`), so while a large call's arguments stream the open
 * text block is still the last block and no longer grows.
 */
export const ANSWER_QUIET_AFTER_MS = 3_000;

/**
 * Whether the answer's open text block is still being written.
 *
 * While the words arrive they are the busy signal, so the turn's busy row
 * ("Gathering thoughts...") stays hidden instead of sitting glued under the
 * streaming text. The row comes back when the block closes (a tool call or
 * the next step starts), and when the text stops growing for `quietMs`: a
 * stream that went silent must not look like a finished answer.
 *
 * `text` is the open block's text (`openTextBlock`), `undefined` when no
 * block is open.
 */
export function useAnswerStreaming(text: string | undefined, quietMs: number = ANSWER_QUIET_AFTER_MS): boolean {
  const hasText = !!text?.trim();
  // The text that last went silent for `quietMs`. Any growth makes it stale,
  // so the row hides again without a reset in the effect.
  const [quietText, setQuietText] = useState<string | null>(null);
  useEffect(() => {
    if (!hasText) return;
    const timer = setTimeout(() => setQuietText(text!), quietMs);
    return () => clearTimeout(timer);
  }, [text, hasText, quietMs]);
  return hasText && quietText !== text;
}
