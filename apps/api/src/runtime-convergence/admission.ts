/**
 * Rule 4 — admission control (the runtime-convergence contract (PR #7785)).
 *
 * "Before a box is handed to a session, it must prove its runtime identity —
 * `config.release.v1` present, `daemon_build >= floor`. A box that fails
 * admission is replaced, not used. The floor is a constant in the API, raised
 * deliberately, never read from the box."
 *
 * The contract's third check — a current `catalog_fingerprint` — left this
 * verdict (KRTX-4642): its box-side reporter was OpenCode-only and deleted
 * with the OpenCode sunset (PR #11218), and pi has no model catalog to prove
 * — its lineup is fetched live from the API at every runtime boot, so the
 * stale-lineup box the check existed for cannot exist. Demanding a proof no
 * box can give refused EVERY box forever (~4,000 observe-only warns a day)
 * and deadlocked the enforce rollout. Re-add this check ONLY together with a
 * box-side reporter hashing a canonical document both sides agree on. The
 * desired document's `catalog_fingerprint` stays (Rule 1's diff,
 * `GET /config`), where a box that never reports it reads as `unknown` — a
 * diff, never a pass.
 *
 * This is the part that makes the top-of-file promise hold for every session
 * from the moment it ships, independent of every box that already exists —
 * the incident that motivated the contract: a box whose boot-time
 * managed-model fetch failed kept the daemon's bundled lineup for 30 days,
 * and after the platform lineup rotated it had no model either side would
 * accept. On pi the lineup is never bundled, so the remaining checks guard
 * the same promise: a box proves the identity it CAN prove, or it is
 * replaced.
 *
 * `evaluateAdmission` is pure and total: every input is already-parsed data
 * (this module never fetches a health endpoint itself — see
 * `admitSandboxForSession` in ./admit-sandbox.ts for the wrapper that reads
 * `GET /kortix/health` and calls this).
 */

/**
 * The monotonic daemon-build floor. Raised deliberately by a human when a new
 * daemon build ships a capability a session must not run without — NEVER
 * derived from anything a box reports (a box that predates a capability
 * cannot be trusted to know it predates it). `0` admits every build that
 * reports a build number at all; it is intentionally low until an incident or
 * a shipped capability justifies raising it, exactly like
 * `RUNTIME_ASSETS_BUILD` is an override, not a default.
 *
 * OPERATOR RUNBOOK: raise this via `dotenvx set RUNTIME_ADMISSION_MIN_DAEMON_BUILD
 * <n> -f apps/api/.env` and redeploy — it is read at module load, not live, so a
 * raise takes effect on the next deploy, matching `daemon_build`'s own
 * once-per-process derivation in runtime-assets/manifest.ts.
 */
function parseMinDaemonBuild(): number {
  const raw = process.env.RUNTIME_ADMISSION_MIN_DAEMON_BUILD?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export const MIN_DAEMON_BUILD = parseMinDaemonBuild();

/**
 * Deployment kill switch — OFF by default, on purpose.
 *
 * `runtime_truth` (Rule 1's actual document) ships on a parallel daemon
 * branch. Every box that exists the day THIS code merges reports nothing, so
 * `evaluateAdmission` refuses every one of them (a box that cannot prove
 * `daemon_build` cannot pass the floor check — see `buildMeetsFloor`). Ungated,
 * that would park every session the moment this deploys, independent of
 * whether the daemon side has shipped.
 *
 * So admission is evaluated and LOGGED unconditionally (`admitRunningSandbox`'s
 * `onRefused` always fires — the failure is observable from the moment this
 * ships), but only ENFORCED — replacing the box instead of handing it to the
 * session — once an operator sets this. Same shape as
 * `RUNTIME_AGENT_SELF_UPDATE` (runtime-assets/manifest.ts): flip it on after
 * confirming boxes report `runtime_truth` in practice, no redeploy required.
 * Anything other than a literal `true`/`1` (case-insensitive) leaves it off, so
 * a typo fails SAFE — towards "observe only", not towards bricking every
 * session-open on a fleet that has not shipped the other half of this yet.
 */
export function runtimeAdmissionEnforced(): boolean {
  const raw = process.env.RUNTIME_ADMISSION_ENFORCE?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export type RuntimeAdmissionCheck = 'config_release_capability' | 'daemon_build_floor';

export type RuntimeAdmissionVerdict =
  | { admitted: true }
  | { admitted: false; failedCheck: RuntimeAdmissionCheck; cause: string };

export interface RuntimeAdmissionInput {
  /** The daemon lists `config.release.v1` in its health `capabilities`. */
  hasConfigReleaseCapability: boolean;
  /** `daemon_build`, as the box reports it (Rule 1's actual document). */
  actual: { daemon_build: string | number | null };
}

function buildMeetsFloor(reported: string | number | null, floor: number): boolean {
  if (reported === null) return false; // cannot prove what it never states
  const numeric = typeof reported === 'number' ? reported : Number(reported);
  return Number.isFinite(numeric) && numeric >= floor;
}

/**
 * Fixed check order — capability, then build floor — so a box failing several
 * checks at once is refused for ONE named reason rather than an ambiguous
 * bundle. Every later check is skipped once one refuses: a refused box is
 * refused, and enumerating every other thing ALSO wrong with it tells the
 * operator nothing the first cause didn't already say clearly.
 */
export function evaluateAdmission(
  input: RuntimeAdmissionInput,
  /** The floor to check against. Defaults to the deployment constant; a
   *  caller never overrides this in production — the parameter exists so a
   *  test can assert the compare without depending on process.env at module
   *  load. */
  floor: number = MIN_DAEMON_BUILD,
): RuntimeAdmissionVerdict {
  if (!input.hasConfigReleaseCapability) {
    return {
      admitted: false,
      failedCheck: 'config_release_capability',
      cause: 'the box does not advertise config.release.v1 in its health capabilities',
    };
  }
  if (!buildMeetsFloor(input.actual.daemon_build, floor)) {
    return {
      admitted: false,
      failedCheck: 'daemon_build_floor',
      cause:
        input.actual.daemon_build === null
          ? `the box does not report a daemon_build, so it cannot prove build >= ${floor}`
          : `daemon_build ${input.actual.daemon_build} is below the floor ${floor}`,
    };
  }
  return { admitted: true };
}
