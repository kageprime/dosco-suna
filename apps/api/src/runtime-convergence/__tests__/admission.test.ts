/**
 * Rule 4 — admission control (the runtime-convergence contract (PR #7785)). Before a box
 * is handed to a session, it must prove `config.release.v1` present and
 * `daemon_build >= MIN_DAEMON_BUILD`. A box that fails ANY check is refused,
 * never used — this is the part that makes "every new session is fresh" true.
 *
 * The contract's third check — a current `catalog_fingerprint` — left
 * admission: its box-side reporter was OpenCode-only and deleted with the
 * OpenCode sunset (PR #11218), and pi has no model catalog to prove (its
 * lineup is fetched live from the API at every runtime boot, so a box cannot
 * hold a stale one). Demanding a proof no box can give refused EVERY box
 * forever (KRTX-4642: ~4,000 observe-only warns a day) and deadlocked the
 * enforce rollout. Re-add this check ONLY together with a box-side reporter.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { evaluateAdmission, MIN_DAEMON_BUILD, runtimeAdmissionEnforced } from '../admission';
import { UNREPORTED_ACTUAL_RUNTIME, type ActualRuntimeDocument } from '../actual';

const CURRENT: ActualRuntimeDocument = {
  ...UNREPORTED_ACTUAL_RUNTIME,
  daemon_build: MIN_DAEMON_BUILD,
};

describe('evaluateAdmission', () => {
  test('admits a box that proves the release capability and a floor-or-above build', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: CURRENT,
    });
    expect(verdict.admitted).toBe(true);
  });

  test('refuses a box that never advertises config.release.v1', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: false,
      actual: CURRENT,
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.failedCheck).toBe('config_release_capability');
      expect(verdict.cause).toContain('config.release.v1');
    }
  });

  test('refuses a box below the daemon-build floor — the boot that could not fetch the managed lineup and never recovered', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: MIN_DAEMON_BUILD - 1 },
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.failedCheck).toBe('daemon_build_floor');
      expect(verdict.cause).toContain(String(MIN_DAEMON_BUILD));
    }
  });

  test('a box that never reports daemon_build at all cannot prove the floor — refused, not admitted by default', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: null },
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.failedCheck).toBe('daemon_build_floor');
  });

  test('admits a modern pi box that never reports a catalog_fingerprint — no reporter exists to demand a proof from (KRTX-4642 regression)', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: CURRENT,
    });
    expect(verdict.admitted).toBe(true);
  });

  test('the daemon_build floor is a STRING-coerced numeric compare (the box may report a string per the wire contract)', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: true,
      actual: { ...CURRENT, daemon_build: String(MIN_DAEMON_BUILD + 5) },
    });
    expect(verdict.admitted).toBe(true);
  });

  test('checks are evaluated in a fixed order — capability, then build floor — so one failure names ONE cause', () => {
    const verdict = evaluateAdmission({
      hasConfigReleaseCapability: false,
      actual: { ...CURRENT, daemon_build: MIN_DAEMON_BUILD - 1 },
    });
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.failedCheck).toBe('config_release_capability');
  });
});

describe('runtimeAdmissionEnforced', () => {
  const KEY = 'RUNTIME_ADMISSION_ENFORCE';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test('defaults OFF — unset, empty, or any non-true value never enforces', () => {
    delete process.env[KEY];
    expect(runtimeAdmissionEnforced()).toBe(false);
    process.env[KEY] = '';
    expect(runtimeAdmissionEnforced()).toBe(false);
    process.env[KEY] = 'false';
    expect(runtimeAdmissionEnforced()).toBe(false);
    process.env[KEY] = 'yes';
    expect(runtimeAdmissionEnforced()).toBe(false);
  });

  test('an explicit true/1 (case-insensitive) enforces', () => {
    process.env[KEY] = 'true';
    expect(runtimeAdmissionEnforced()).toBe(true);
    process.env[KEY] = 'TRUE';
    expect(runtimeAdmissionEnforced()).toBe(true);
    process.env[KEY] = '1';
    expect(runtimeAdmissionEnforced()).toBe(true);
  });
});
