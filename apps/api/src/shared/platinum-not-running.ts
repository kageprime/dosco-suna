/**
 * Platinum control-plane not-running classification.
 *
 * `shared/platinum.ts` throws its typed `PlatinumSandboxNotRunningError` for
 * every 409 whose body carries `sandbox_not_running`, from any method — a GET
 * for a natively auto-stopped box answers the same 409 its expose/exec give.
 * That verdict IS the stopped state (the box never reaches `running` without
 * a /start), and it is the one error that changes the box's world: callers
 * use it to justify a start past a stale status read, to wake + retry, or to
 * treat the box as stopped.
 *
 * Matched by the pinned class NAME, not an instanceof: the provider tests
 * mock `shared/platinum` wholesale and construct stand-in errors (see
 * `__tests__/helpers/platinum-http-error.ts`), so only the name survives
 * every mock. Name-matched like the established TimeoutError check.
 */
export function isPlatinumNotRunningVerdict(err: unknown): boolean {
  return err instanceof Error && err.name === 'PlatinumSandboxNotRunningError';
}
