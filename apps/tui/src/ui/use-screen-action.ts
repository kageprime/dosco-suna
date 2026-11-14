import { useCallback, useState } from 'react';

import { errorText } from '../lib/errors.ts';
import type { ToastKind } from './toast.tsx';

/** The screen's toast line: the app routes it to the status bar. */
export type ScreenToast = (message: string, kind?: ToastKind) => void;

/**
 * The one busy line + toast wrapper every screen write shares.
 *
 * `run` sets the busy line, awaits the work, toasts the `done` phrase — or
 * the string the work returns — and clears the line; a rejection toasts the
 * error's own message (`lib/errors.ts`) with kind `error` and still clears
 * it. `refresh` is the same walk for a refetch, whose result is not a string
 * and so toasts nothing.
 */
export function useScreenAction(onToast: ScreenToast | undefined) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    (label: string, work: () => Promise<unknown>, done?: string) => {
      setBusy(label);
      void (async () => {
        try {
          const result = await work();
          if (done !== undefined) onToast?.(done);
          else if (typeof result === 'string' && result) onToast?.(result);
        } catch (error) {
          onToast?.(errorText(error, 'Unknown error'), 'error');
        } finally {
          setBusy(null);
        }
      })();
    },
    [onToast],
  );

  const refresh = useCallback((label: string, work: () => Promise<unknown>) => run(label, work), [run]);

  return { busy, run, refresh };
}
