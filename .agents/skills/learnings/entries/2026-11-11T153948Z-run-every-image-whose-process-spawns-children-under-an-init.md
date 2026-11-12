---
recorded: 2026-11-11T15:39:48Z
incident_date: 2026-11-03
---
# Run every image whose process spawns children under an init (tini); Bun as PID 1 never reaps orphans and aborts when PIDs run out

**Rule:** A container whose main process starts child processes (git, a shell, a CLI) runs an init as PID 1: `ENTRYPOINT ["/usr/bin/tini", "-s", "--", ...]` in the image, or `init: true` in compose. Never let `bun` be PID 1. A deploy config overrides only the command (ECS and compose `command`, Kubernetes `args`), never the entrypoint (Kubernetes `command`).

**Trigger surface:** writing or changing a Dockerfile `ENTRYPOINT`/`CMD`, an ECS task definition `entryPoint`, a compose or Kubernetes `command`, or adding a child process to a service. Also: a "Bun has crashed" report whose stack ends in `WTF::Thread::create`.

**Incident:** From 2026-11-03 the prod worker aborted every 84–147 min, `panic(main thread): abort() called` in `WTF::Thread::create`, at ~230k spawns; staging every ~15 h. Bun was PID 1. git detaches its auto-maintenance after every `fetch` and `commit`, and each orphan stayed as a zombie until no PID was left for a thread. Each restart lost the connector sweep's in-memory tip cache, so cold reads made the next crash come sooner. Daily jobs (the audit archive) never finished. A local repro (Bun 1.4.4, git 2.47) left 1 zombie per fetch as PID 1 and 0 under tini. Fixed by tini in the API image (PR #12439).

**Enforcement:** `apps/api/src/__tests__/unit-api-image-init.test.ts` fails when the API image's runtime stage loses the tini `ENTRYPOINT`. At boot, `prepareProcess` (`apps/api/src/bootstrap.ts`) warns `[startup] Running as PID 1 without an init` and the worker logs its `pid`.
