---
recorded: 2026-11-10T13:52:09Z
incident_date: 2026-11-10
supersedes: 2026-11-07T232324Z-turn-off-a-vercel-git-deploy-in-the-project-not-with-a-scrip.md
---
# Build the Vercel frontend on a GitHub runner and upload it prebuilt; never let Vercel build it

**Rule:** kortix.com and staging.kortix.com deploy only through `infra/scripts/vercel-deploy-prebuilt.sh`: `vercel pull`, `vercel build` on the runner, then `vercel deploy --prebuilt --archive=tgz`. Never run a `vercel deploy` from source or a dashboard Redeploy. A build outside Vercel must set what Vercel's build machines set: `VERCEL=1` (baked runtime config, prerendered pages), `NEXT_ENABLE_ADAPTER=1` and `VERCEL_IMMUTABLE_STATIC_FILES_ENABLED=1` (scripts on `/_next/static/immutable/`, so their URLs survive a deploy), and a deployment ID unique to the project (Skew Protection). The script sets all four. To rebuild by hand, run the script with the `--env` and `--build-env` values that `deploy-prod.yml` passes. kortix.com still deploys only after `verify-live-version` (2026-08-10). Before you stop the builds of any Vercel project, list its domains that follow a git branch.

**Trigger surface:** Editing a Vercel step in `deploy-staging.yml` or `deploy-prod.yml`, the script, `deploymentId` in `apps/web/next.config.ts`, or the build settings of any Vercel project.

**Incident:** 2026-11-07 to 2026-11-10 cost review. It corrects the superseded entry: a cancelled build bills $0 (charges API: 120 cancelled builds on 2026-11-07, 0 Build CPU Minutes), so its "~77 % / ~$260 a month" was wrong. The cost was finished builds: ~$0.56 each on the 30-core machine, ~3 min of build plus ~4 min to save a 3 GB build cache, ~$100-250 a month for staging and prod deploys. Near-miss on the same day: a production-only build rule on the Platinum Vercel project stopped dev.platinum.dev and staging.platinum.dev for ~27 h (68 `main` and 16 `staging` pushes), because both sites are branch previews.

**Enforcement:** `tests/unit/web-ecs-workflow.test.ts` ("never builds the frontend on Vercel": both workflows call the script and no `vercel deploy`/`build`; "uploads every Vercel deploy as one archive" now reads the script). `tests/unit/vercel-deploy-prebuilt.test.ts` runs the script with a stub CLI: `VERCEL=1`, the adapter and immutable flags, the deployment ID, `--build-env` winning over pulled values, `--prebuilt --archive=tgz`, `--prod`. The branch-domain check has no enforcer.
