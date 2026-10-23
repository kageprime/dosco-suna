---
recorded: 2026-10-23T21:26:31Z
incident_date: 2026-10-23
---
# Count the Heroku image layers and give every directory COPY an explicit destination

**Rule:** Before pushing an image to Heroku's Common Runtime, count the final-stage instructions and keep them under 40 (the image that boots today has 32). In a Dockerfile, give every directory `COPY` source an explicit destination path: `COPY dir ./target/dir`. A merged `COPY a b ./target/` copies the *contents* of each directory into `target/` and silently drops the directory name.

**Trigger surface:** Editing `Dockerfile.heroku` or syncing it from `apps/api/Dockerfile`; adding a `COPY` of a workspace package or a runtime-fingerprinted source tree.

**Incident:** 2026-10-23, the unified-tree deploy. Releases v39-v55 reused origin's `apps/api/Dockerfile` verbatim: 75 final-stage instructions. The Common Runtime refused to start the image with no `Starting process` line and no stdout (`crashed` 2-18 s after start). Consolidating to 29 instructions made the container start and name the next failures. Two merged `COPY` lines had flattened directory sources: `agent-tunnel/src` (boot died with `Cannot find package 'agent-tunnel'`) and `apps/sandbox/slack-cli`, `apps/kortix-sandbox-agent-server/src`, `apps/cli/src` (startup pre-build died with `ENOENT ... lstat`). Final image: 32 instructions, release v61. Proof: `web.1 up`, `/health` 200, `/health/ready` 200, CORS preflight 204, `[snapshots] startup pre-build (e2b): default image ... ready`.

**Enforcement:** none yet: a CI check that counts the final-stage instructions in `Dockerfile.heroku` and fails over 40, plus a lint that rejects a `COPY` with more than one source when any source is a directory and the destination does not name it. Until then: the canary app (`dosco-boot-debug`) must boot and log the pre-build `ready` line before a prod push.
