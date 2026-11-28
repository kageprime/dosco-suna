---
recorded: 2026-11-24T00:16:37Z
incident_date: 2026-11-24
---
# Never date a migration in the future; rename it to a past timestamp before it merges

**Rule:** Give every migration in `packages/db/migrations/` a timestamp at or before the time you commit it. When a generated migration must sort after a hand-dated one that is later than now, re-date both to past timestamps; never stack new files on top of a future date.

**Trigger surface:** Generating a migration (`bun scripts/generate.ts`) whose stamp sorts before a hand-written migration already applied locally, or hand-naming a migration with a round future time such as `…010000000` to force an order.

**Incident:** 2026-11-24, artifact gallery folders (PR #13030), near-miss caught before the merge. A hand-dated `20261124010000000` validation migration (01:00 UTC) led to three more nested-folder migrations at `…0101…` to `…0103…`, while the clock read 00:15 UTC. node-pg-migrate runs with `checkOrder`. Once these were applied on dev, any migration another branch generated before 01:00 UTC that day would have sorted before them and been refused ("Not run migration … is preceding already run migration"), blocking that branch's deploy. Fix: renamed the four to `20261123230000000`–`20261123230300000`, updated the one test and one override comment that named a file, and renamed the matching `kortix_migrations.pgmigrations` rows in the only database that had run them (the branch's local worktree database).

**Enforcement:** none yet: `bun scripts/lint-migrations.ts` should reject a migration whose 17-digit timestamp is later than the current UTC time plus a small skew.
