---
recorded: 2026-11-08T18:15:40Z
incident_date: 2026-11-08
---
# Keep core.hooksPath relative (.githooks) so each worktree runs its own branch's hooks

**Rule:** Set `core.hooksPath` to the relative `.githooks`, never to an absolute path. A relative path runs each worktree's own hooks. An absolute path runs the primary checkout's hooks in every worktree, from whatever branch the primary has checked out, so a hook fix on `dev` does not reach worktrees until someone updates the primary.

**Trigger surface:** Running `git config core.hooksPath`, cloning or repairing the primary checkout, editing `.githooks/*`, or a hook that behaves like an older version of itself.

**Incident:** 2026-11-08, existing-repo onboarding branch. The primary checkout had `core.hooksPath=<primary>/.githooks` (absolute) and sat on a local `dev` from 2026-11-05. A commit in a worktree ran that old pre-commit, which still called `dotenvx protect` (removed on `dev` 2026-11-07, PR #12037). It rewrote the global `filter.dotenvx.*` (`required = true`) to the worktree's `node_modules`. `pnpm worktree nuke` then deleted that binary, and `git worktree add` failed for every repository on the machine with `MODULE_NOT_FOUND` until the filter was pointed at the global dotenvx CLI.

**Enforcement:** `pnpm worktree create` resets an absolute `core.hooksPath` to `.githooks` and prints the old value (`scripts/worktree/cli.ts`, cmdCreate). The root `prepare` script sets `.githooks` on `pnpm install`. Related: [[2026-11-07T153129Z-never-run-dotenvx-protect-from-a-hook-or-script-install-it-o]].
