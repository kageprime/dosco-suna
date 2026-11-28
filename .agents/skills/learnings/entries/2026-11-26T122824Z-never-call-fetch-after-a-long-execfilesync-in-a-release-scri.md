---
recorded: 2026-11-26T12:28:24Z
incident_date: 2026-11-25
---
# Never call fetch after a long execFileSync in a release script; run long CLI commands asynchronously

**Rule:** In a Node script that calls `fetch`, run a command that takes more than a
few seconds (`eas build --wait`, `eas submit --wait`) asynchronously (`spawn`), never with
`execFileSync`. Log a failed fetch with its `cause`, not only its message.

**Trigger surface:** Writing or editing a release script under `apps/mobile/scripts/` or any CI
script that mixes child processes with HTTP calls. Diagnosing a `fetch failed` that a local
run does not reproduce.

**Incident:** Every automatic `Mobile Store` run that built iOS stopped after the TestFlight
upload with `fetch failed`, 3 ms after `eas submit` returned: 1.6.36 (2026-11-14), 1.6.48,
1.6.49 and 1.6.56 (2026-11-25). Android shipped each time; nothing calls fetch after its
submit. A person re-ran the workflow for three of them; 1.6.49 got only a dry run and never
reached App Review, so iOS stayed on 1.6.48 while Play had 1.6.56. Cause: `execFileSync`
blocked the event loop for the ~12 min build, so fetch's 4 s idle timer never closed its
keep-alive connection to api.expo.dev, and the Vulcan runner's network dropped it. The next
fetch wrote to it: `EPIPE`. A probe on `vulcan-4vcpu-ubuntu-2404` reproduced it (700 s
`execFileSync` → EPIPE in 3 ms; 700 s async wait → 200). macOS and a Linux container did
not, which is why #13086 had read it as a random dropped connection.

**Enforcement:** `apps/mobile/scripts/store-release.test.ts` ("a long EAS command keeps the
event loop running") fails if `run()` blocks. The retry in `fetchWithRetry` and the
twice-daily `--finish-only` run in `mobile-store.yml` cover what remains.
