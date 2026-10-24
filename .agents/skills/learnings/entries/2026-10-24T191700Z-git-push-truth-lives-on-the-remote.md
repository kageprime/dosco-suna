---
recorded: 2026-10-24T19:17:00Z
incident_date: 2026-10-24
---
# A git push's truth lives on the remote, not in the client process or its exit code

**Rule:** After a `git push` that outlives or outgrows its client shell, verify the remote state (`git ls-remote <remote>`, `heroku releases`, `heroku ps`) before re-running the push. A killed client does not kill the server-side build; re-pushing the same SHA releases it twice.

**Trigger surface:** Long git pushes to a remote that builds server-side (Heroku), from a shell whose foreground cap kills the client at ~120 s while the remote build takes several minutes.

**Incident:** 2026-10-24, Heroku deploys v70 → v72. A foreground `git push heroku ...` was killed at its client-side timeout. The remote had already received the objects and kept building — it released the code later as v71. The background re-push then built and released the same SHA again as v72 (with the "duplicate build version" notice). Harmless (identical code, two releases, ~3 min apart), but the whole thing was invisible to exit codes: both pushes reported `code 1` through PowerShell stderr wrapping while one was mid-build and one was already landed. The only reliable signal at every step was `git ls-remote` plus `heroku releases`/`heroku ps`.

**Enforcement:** Treat any git push longer than ~90 s as background, and read the ground truth from the remote before acting on any exit code: `git ls-remote heroku refs/heads/main`, `heroku releases -a dosco -n 3`, `heroku ps -a dosco`. An inconclusive client state is never a reason to push again.
