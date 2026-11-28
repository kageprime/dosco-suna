---
recorded: 2026-11-28T02:35:23Z
incident_date: 2026-11-28
---
# Never install a full dependency tree in a scratch worktree below 5 GB free

**Rule:** Regenerate the lockfile with `pnpm install --lockfile-only --no-frozen-lockfile` and link the primary `node_modules` with junctions for scratch worktrees. Run a full `pnpm install` only above 10 GB free.

**Trigger surface:** Merging upstream into an isolated git worktree on a disk-constrained Windows machine, then running typechecks or tests there.

**Incident:** 2026-11-28 upstream sync. A full `pnpm install --frozen-lockfile --offline` in a scratch worktree consumed the remaining 4 GB and failed with `ENOSPC`; removing the worktree's `node_modules` and pruning the store recovered the disk. Verification moved to the canonical checkout, which already had dependencies.

**Enforcement:** none yet: a preflight check in `scripts/worktree/cli.ts` that refuses `create` below the existing 4 GB guard already exists; extend it to warn on full installs in non-registered worktrees.
