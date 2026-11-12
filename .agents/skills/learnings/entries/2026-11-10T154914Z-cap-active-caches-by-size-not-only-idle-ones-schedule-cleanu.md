---
recorded: 2026-11-10T15:49:14Z
incident_date: 2026-11-10
---
# Cap active caches by size, not only idle ones; schedule cleanup from a bundle, not a checkout

**Rule:** A cache that grows while in use (`apps/web/.next`, build output)
gets a size cap that applies whenever its process is stopped, not only an
idle rule: an active checkout is never idle. Count a merged PR as pushed. Clean
every worktree kind (registry slots and `.claude/worktrees/agent-*`). Run the
schedule from a standalone bundle with an explicit repo root, never from a
checkout that can lag `dev` or be removed. Under low disk, trim shared caches.

**Trigger surface:** Disk full on a dev machine; changing `scripts/worktree`
autoclean, sweep, cap or schedule rules; adding a tool that keeps a cache.

**Incident:** 2026-11-10, after PR #12258 the 98 GB `/work` volume still sat at
60%: active worktrees held 6.5–14 GB each (`.next` up to 7 GB, never idle),
Claude isolation worktrees and 78 `worktree-agent-*` branches were invisible,
squash-merged branches counted as unpushed forever, the hourly cron was opt-in
and ran the primary checkout's stale code (and this box has no cron daemon).

**Enforcement:** `autoclean` on `create`/`start` and every 15 min (cron or a
detached loop, auto-installed); `scripts/worktree/__tests__/autoclean-cap-pressure.test.ts`,
`autoclean-git.test.ts`, `autoclean-schedule.test.ts` pin the cap, pressure,
merged, Claude-lock, branch and bundle-staleness rules.
