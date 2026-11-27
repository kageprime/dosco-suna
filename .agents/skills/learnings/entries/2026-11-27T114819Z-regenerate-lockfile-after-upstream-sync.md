---
recorded: 2026-11-27T11:48:19Z
incident_date: 2026-11-27
---
# After an upstream sync, verify pnpm-lock.yaml matches package.json with pnpm install --frozen-lockfile

**Rule:** After merging upstream into a Dosco branch, regenerate `pnpm-lock.yaml` when root `package.json` overrides or patches changed, and run `pnpm install --frozen-lockfile` before merging. Never let a merge keep the new `package.json` with the old lockfile.

**Trigger surface:** Any upstream sync merge, or any edit to root `package.json` overrides, patched dependencies, or `pnpm-workspace.yaml` overrides.

**Incident:** 2026-11-27. Security commit `cddca3c4b4` pinned Next.js 16.4.5 in `package.json` and the lockfile. Upstream sync merge `be51f0d9ee` restored the upstream lockfile with Next.js 16.4.2 while keeping the newer `package.json`. Frozen installs broke repo-wide; EAS APK build `7bba6bf0` failed in `INSTALL_DEPENDENCIES` with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.

**Enforcement:** EAS `INSTALL_DEPENDENCIES` caught it with `pnpm install --frozen-lockfile`. None in CI yet: add a T0 gate that runs `pnpm install --frozen-lockfile --lockfile-only` when `package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` changes.
