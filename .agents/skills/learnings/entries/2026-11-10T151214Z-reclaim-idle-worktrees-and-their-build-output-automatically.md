---
recorded: 2026-11-10T15:12:14Z
incident_date: 2026-11-10
---
# Reclaim idle worktrees and their build output automatically; never count a read as worktree activity

**Rule:** Build output and idle worktrees are reclaimed by `pnpm worktree
autoclean`, which `create` and `start` run first: sweep build output idle ≥ 24h,
remove worktrees idle ≥ 48h that are stopped, unbusy, clean and fully pushed.
Activity is `createdAt`, `lastUsedAt`, HEAD commit time and changed-file mtimes.
A read (`git status`, `ls`) must never count: never use the index mtime.

**Trigger surface:** Disk full on a dev machine; changing `scripts/worktree`
activity, prune or sweep rules; adding a file the dev server rewrites.

**Incident:** 2026-11-10, the 98 GB `/work` volume (no autogrow) hit 100%
(46 MB free), as on 2026-11-04 and 2026-11-06. Cleanup ran by hand only. A
worktree holds ~1.3 GB unshared plus `apps/web/.next` (3.4 and 7.0 GB seen).
`nuke --all --idle` read a refreshed index as "active 1m ago", and a dev-server
rewrite of `content-timestamps.json` made 7 idle worktrees "dirty". Removing 30
idle worktrees by hand: 100% → 59%.

**Enforcement:** `autoclean` on `create`/`start` (opt-in hourly cron with
`--install-cron`); disk guard warns < 10 GB, `create` exits 2 < 4 GB;
`scripts/worktree/__tests__/autoclean.test.ts` pins idle, busy, noise-only,
branch, threshold and disk-guard rules.
