---
recorded: 2026-11-24T23:14:10Z
incident_date: 2026-11-24
---
# When the last nightly is red, run the contract lanes on the dev SHA before a Promote dispatch; the tripwires do not cover the package and DB lanes

**Rule:** Before a Promote dispatch, when the last nightly `Tests` run on `dev` is red or `dev` moved since it ran, dispatch the contract lanes on the `dev` SHA you promote: `gh workflow run tests.yml --repo kortix-ai/CompanyOS --ref dev` (about 15 min on free runners). Fix every red lane on `dev` first, then promote. `scripts/pre-promote-tripwires.sh` stays the first check: it is 2.5 min, but it runs no DB suite and no package test outside its list.

**Trigger surface:** dispatching `promote.yml`; a red nightly comment on a `dev` commit; a release candidate that has many merges since the last nightly.

**Incident:** 2026-11-24, v0.16.5. The nightly on `dev` was red, and 14 more merges landed after it. The tripwires found 9 reds. A `tests.yml` run on the fix branch found 6 more in `core-db`, `packages-api` and `packages-rest`: a DB enum list, a skill platform switch, a codemod check, 2 mobile tests and 1 UI copy test. Most came from same-day features whose authors merged without the tripwires. Fixes: #13061. The second `tests.yml` run, on the promoted SHA, passed in all 7 lanes before the release suite started. Without it, the release suite would have found them after about 1 h, once per fix round.

**Enforcement:** the kortix-release skill, Step 2, names this run. `scripts/pre-promote-tripwires.sh` now also runs `unit-skills-offered.test.ts` and `unit-workspace-route-params.test.ts`, 2 of the 6 reds it missed. Nothing yet makes `promote.yml` wait on a green `tests.yml` run for the promoted SHA. The same release then failed twice more on checks outside every lane: the deployed MEMORY-4 flow (new drives became shared volumes with no history; #13066 made them opt-in) and gitleaks on a synthetic test password (#13068). The tripwires now also run gitleaks over `origin/prod..HEAD` (14 s).
