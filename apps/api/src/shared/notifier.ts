/**
 * One fire-and-forget relay registry: register a relay at startup, `notify`
 * hands the event to every registered relay in registration order; one
 * relay's failure — a sync throw or a rejected promise — is logged through
 * `onRelayError` and never stops the next relay or reaches the caller.
 * `onRelayError` logs the failure the hook's own way (its logger and field
 * names); `event` is `'failed'` for a rejected relay promise and `'threw'`
 * for a sync throw.
 */
export function createNotifier<TArgs extends unknown[]>(
  onRelayError: (error: unknown, args: TArgs, event: 'failed' | 'threw') => void,
) {
  // replica-local: each replica registers the same relays at startup; notify calls them in its own process.
  const relays = new Set<(...args: TArgs) => unknown>();
  return {
    /** Register a relay. Registering the same function twice keeps one. Returns the remover. */
    register(fn: (...args: TArgs) => unknown): () => void {
      relays.add(fn);
      return () => {
        relays.delete(fn);
      };
    },
    /** Never throws, never blocks. */
    notify(...args: TArgs): void {
      for (const relay of relays) {
        try {
          void Promise.resolve(relay(...args)).catch((err) => onRelayError(err, args, 'failed'));
        } catch (err) {
          onRelayError(err, args, 'threw');
        }
      }
    },
  };
}
