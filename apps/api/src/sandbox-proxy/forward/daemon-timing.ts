import { setContextField } from '../../lib/request-context';

/**
 * The box's own answer to "why was that runtime read slow" (KRTX-4459).
 *
 * The daemon rides `Server-Timing` on its `/kortix/runtime/*` turn-verb
 * answers: `daemon;dur=<handler wall ms>` and `lag;dur=<peak event-loop
 * slip>`. The API's own `up;dur` (`timeUpstream`) already covers the hop
 * (connect + headers + box), but from outside there was NO way to split "the
 * box's daemon process was slow" from "the ingress edge took the time" — the
 * exact hole the /pending p95 investigation hit: every ≥1 s row read
 * `upstream_ms ≈ the whole duration` and pointed nowhere. Reading the box's
 * own stamp turns a slow row into one line:
 *
 * - `daemon` ≈ `up` -> inside the box, handler-level;
 * - high `lag` -> the box's event loop was blocked while it answered
 *   (boot reconcile, an agent turn, a log re-serialization) — the daemon
 *   attributing case;
 * - `daemon` tiny -> the ingress hop ate the time, outside the box.
 */

/** Names the daemon stamps on its turn-verb responses. */
const DAEMON_STAGE = 'daemon';
const LOOP_LAG_STAGE = 'lag';

interface DaemonTiming {
  daemonMs: number;
  lagMs: number;
}

const ENTRY_RE = /^\s*([\w-]+)\s*;\s*dur=(\d+(?:\.\d+)?)(?:;.*)?\s*$/;

/** Parse a `Server-Timing` header into the daemon's entries, or null.
 *  Entries the grammar refuses (a negative or a non-numeric `dur`) are
 *  skipped. A `,` inside a quoted `desc` of some future entry splits that
 *  entry in two; the head still parses and the offcut is skipped. */
export function parseDaemonTiming(header: string | null | undefined): DaemonTiming | null {
  if (!header) return null;
  let daemonMs: number | null = null;
  let lagMs: number | null = null;
  for (const entry of header.split(',')) {
    const match = ENTRY_RE.exec(entry);
    if (!match) continue;
    if (match[1] === DAEMON_STAGE) daemonMs = Math.round(Number(match[2]));
    else if (match[1] === LOOP_LAG_STAGE) lagMs = Math.round(Number(match[2]));
  }
  if (daemonMs === null || lagMs === null) return null;
  return { daemonMs, lagMs };
}

/** Parse the upstream's header and stamp both values on the request context.
 *  No-op outside a request scope, and no fields when the box sent no stamp. */
export function recordDaemonTiming(headers: Headers): void {
  const parsed = parseDaemonTiming(headers.get('server-timing'));
  if (!parsed) return;
  setContextField('sandbox_daemon_ms', String(parsed.daemonMs));
  setContextField('sandbox_loop_lag_ms', String(parsed.lagMs));
}
