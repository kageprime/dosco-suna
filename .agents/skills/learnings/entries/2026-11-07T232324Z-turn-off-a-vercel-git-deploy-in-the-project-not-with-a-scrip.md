---
recorded: 2026-11-07T23:23:24Z
incident_date: 2026-11-07
supersedes: 2026-08-10T191010Z-the-prod-frontend-must-never-deploy-before-the-api-serves-th.md
---
# Turn off a Vercel Git deploy in the project, not with a script that cancels it

**Rule:** When a Vercel project must not build on a push, remove its Git connection or set `git.deploymentEnabled`. An Ignored Build Step script still starts a build machine for every push. The 2026-08-10 rule stands: kortix.com deploys only from `deploy-prod.yml` `deploy-web-vercel`, after `verify-live-version`.

**Trigger surface:** Changing `apps/web/vercel.json`, the Vercel project's Git settings, or how a Vercel project deploys.

**Incident:** 2026-11-07 cost review. Dev, staging and prod no longer deployed from Git, but every push to any branch still created a Vercel deployment. The ignore script cancelled it after ~20 s on a 30-core build machine. That was 1,892 cancelled builds from 2026-11-01 to 2026-11-07, ~77 % of the web project's build cost (~$260 a month). The Git connection was removed, and the script was deleted.

**Enforcement:** `tests/unit/web-ecs-workflow.test.ts` requires `git.deploymentEnabled: false` and no `ignoreCommand` in `apps/web/vercel.json`. It also checks the ignore script is gone. The project's missing Git connection lives only in Vercel's settings. No test reads it.
