# kortixd

Thin sandbox-side daemon that runs inside every Kortix project-session sandbox.

The compiled binary is a single, installable app named **`kortixd`**. Running
it with no arguments (or `kortixd serve`) starts the daemon described below.
It also manages its own lifecycle — see [Management CLI](#management-cli).

> **Binary name compatibility.** The npm package and the product name are now
> `kortixd`. The build still ALSO emits `dist/kortix-agent`, and the sandbox
> image still bakes `/usr/local/bin/kortix-agent`. That path is a load-bearing
> contract: `apps/sandbox/entrypoint.sh` treats it as the immutable floor, the
> snapshot bake COPYs it, and the API serves it as the runtime-assets `/agent`
> artifact for already-deployed boxes. Renaming that on-disk path is a fleet
> migration, not a build change, so both names ship from one compile.

**Scope:**

1. Runs the session harness, pi, inside the daemon process. There is no child
   process. OpenCode is deleted: a box that OpenCode booted before the sunset
   boots pi too. See [the harness README](src/harness/README.md).
2. Serves the session runtime's HTTP + SSE surface on `KORTIX_SERVICE_PORT`
   (default `8000`): pi's own handlers, the transcript (`kortix.transcript.v1`)
   and the events.
3. Managed Kortix system skills for the harness: pi reads them from the image's
   overlay directory, with nothing written into the working tree.
4. Kortix-namespaced control surface under `/kortix/*`: `GET /kortix/health`,
   `POST /kortix/refresh`, the Runtime API (`/kortix/runtime/*`) and the
   routes [ARCHITECTURE.md](ARCHITECTURE.md) lists.
5. Static web server on `KORTIX_STATIC_PORT` (default `3211`) — serves any
   HTML/asset the agent writes to disk, injecting a `<base>` tag so relative
   assets resolve cleanly through the sandbox proxy. Ported from main's
   always-on `core/services/static-web.js` s6 service; now runs in-process
   (see `src/services/static-web/static-web.ts`). `apps/web` builds preview URLs against this exact
   port via `/proxy/3211/*` and the `p3211-<sandboxId>` subdomain route.

Everything else — triggers, channels, connectors, secrets, preferences — is
deliberately **not** the daemon's concern. Those live in the cloud API and
either run there directly or are injected into the sandbox as plain
environment variables at create-time. The daemon does not read them, expose
them, or know they exist.

Replaces the legacy multi-script bootstrap and s6 service definitions with one
in-process daemon.

## Source layout

The source has four layers, bottom to top: **shared** (`src/lib/` building blocks and
`src/types/` shared types), **services** (`src/services/`, host capabilities),
**harness** (`src/harness/`, the session runtime: pi), and **app**
(`src/main.ts`, `src/app/`, `src/routes/`: startup and HTTP controllers). A layer
imports only from the layers below it. [ARCHITECTURE.md](ARCHITECTURE.md) lists every folder, the
import rules, and where new code goes; `bun run lint` enforces them.

## Boot flow

1. Read env vars (`src/lib/config/config.ts`).
2. Start the static web server on `0.0.0.0:KORTIX_STATIC_PORT` (in-process).
   It only reads files off disk, so it comes up first and stays up regardless
   of repo/harness state — previews work while the agent is still booting.
   Non-fatal: a bind failure is logged and `static_web_port` reports `null`.
3. Download the config release the runtime boots from, through the config
   provider (`src/services/config-provider/`): the S3 project snapshot first,
   the API archive second. The daemon never clones the project repository:
   `/workspace` starts empty, and an agent that needs the files runs
   `kortix workspaces clone`. `sandbox.on_boot` reads `kortix.yaml` from the
   running config release and runs in `/workspace`.
4. Resolve the skill directories. pi reads the managed system skills from the
   image's overlay directory first, then exactly the skill folders kortix.yaml
   registers. It writes nothing into the working tree. Every session takes its
   agents, registered skill folders, commands and extensions only from the
   compiled agent set (`KORTIX_COMPILED_AGENT_CONFIG`) and reads no
   `harnesses/`, `.kortix/`, `.opencode/` or `.pi/` folder and scans no
   `skills/` folder. A set without `schema: 3` (My Kortix's, an older API's)
   runs its agents with the built-in subagents (`general`, `explore`). Without
   a compiled set, pi runs `KORTIX_AGENT_NAME` (else `build`) on its default
   system prompt.
5. Start the Hono server on `0.0.0.0:KORTIX_SERVICE_PORT`.
6. Start pi in the daemon process ([harness README](src/harness/README.md),
   "The pi harness"). A box that OpenCode booted before the sunset restores its
   session log into pi first.
7. Trap signals; on shutdown, drain the server and the static web server.

## Routes

| Path                   | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `GET /kortix/health`   | Daemon liveness + harness state + git info of `/workspace` (always 200 from daemon) |
| `POST /kortix/refresh` | Signed-context protected fast-forward of a clone in `/workspace` + pi skill reload. |
| `/kortix/runtime/*`    | The Runtime API: the Kortix contract clients build on (transcript, turn verbs, agents). |
| `/*`                   | The harness's own routes, answered by pi. 503 with `code: "runtime_not_ready"` while the runtime is not ready. |

### `GET /kortix/health` response shape

```json
{
  "daemon": "ok",
  "capabilities": ["file.import", "file.append", "config.release.v1", "session.subagents", "session.compact", "…"],
  "status": "ok",
  "runtimeReady": true,
  "boot_error": null,
  "uptime_s": 123,
  "static_web_port": 3211,
  "repo": "https://github.com/owner/name.git",
  "branch": "main",
  "commit_sha": "abc123...",
  "runtime": { "running": { "harness": "pi", "harness_version": "pi-agent-core@1.4.0", "…": "…" } },
  "harness": {
    "id": "pi",
    "version": "pi-agent-core@1.4.0",
    "state": "ok",
    "ready": true,
    "error": null,
    "session": { "id": "ses_…", "required": true },
    "turn": null,
    "details": { "model": "kortix/…", "extensions": { "…": "…" }, "agentsMd": null }
  }
}
```

- `daemon` is always `"ok"` if the route responds.
- `harness` is the selected harness's closed block (E19). `runtimeReady` is
  `harness.ready` (`routes/kortix/health.ts`). Readiness has no repository
  gate. `capabilities` lists the host features, then the session
  features pi serves (E1): `session.subagents`, `session.compact`,
  `session.commands`, `session.steer` and `session.log.v2`.
- `harness.state` is `"ok"`, `"starting"` or `"down"`. A pi
  that cannot start reports `"down"` and its reason in `harness.error`.
- `repo`, `branch`, `commit_sha` come from `git` in `KORTIX_PROJECT_TARGET`
  (`/workspace`). They are `null` until an agent clones the repository there.

### `POST /kortix/refresh`

Requires the sandbox service bearer or a valid `X-Kortix-User-Context` signed
with `KORTIX_TOKEN`. On success, the daemon fetches origin, runs
`git pull --ff-only` for the session branch, and pi re-reads its skills in
place; nothing restarts. `?repo=0` skips the pull. `?on_boot=1` reruns the
project's `sandbox.on_boot` command, for a direct service call only
(`403 BOOT_HOOK_FORBIDDEN` otherwise). Every other query flag is ignored,
including the OpenCode-era flags removed on 2026-10-30 (`base=1`, `base_sha`,
`restart=0`, `base_config=1`, `config_dir=1`, `verify_fail=1`).
Missing/invalid auth returns `401`. A refresh already running, no git
repository in `/workspace` or a non-fast-forward conflict returns `409`.

## What lives elsewhere

- **Triggers** — cloud API (`apps/api/`). The cloud API fires triggers against
  the sandbox from outside; the daemon does not host them.
- **Channels / connectors** — cloud API.
- **Secrets** — cloud API decides which secrets a sandbox needs and sets them
  as plain environment variables at create-time (via Daytona env injection).
  The daemon does not read them and has no `/kortix/secrets` route.
- **User preferences** — deferred. pi has no runtime config document.

## Env vars

```
KORTIX_SERVICE_PORT=8000
KORTIX_HARNESS=pi                         # "pi"; "opencode" or unset (a box OpenCode booted) boots pi too (src/harness/harness.ts)
KORTIX_STATIC_PORT=3211
KORTIX_WORKSPACE=/workspace
KORTIX_PROJECT_TARGET=/workspace         # the session's folder; the daemon never clones into it
KORTIX_DEFAULT_BRANCH=main
KORTIX_CONFIG_RELEASE=                    # base64 JSON of the published config release, signed by the API at session create
KORTIX_REPO_URL=                          # for `kortix workspaces clone` / `git clone` by the agent
KORTIX_BRANCH_NAME=                       # the session branch
KORTIX_GITHUB_TOKEN=
KORTIX_TOKEN=
```

## Build

```
bun install
bash scripts/build.sh
```

Produces `dist/kortixd` (primary) plus `dist/kortix-agent` (compatibility copy;
see the note at the top) — a single-file Bun binary targeting `bun-linux-x64`
by default. Set `BUN_COMPILE_TARGET` for another architecture. The Linux binary
built on macOS will not execute locally; that's expected. To smoke-test the
daemon on macOS, run from source:

```
KORTIX_SERVICE_PORT=9999 bun run src/main.ts
curl -s http://localhost:9999/kortix/health
```

The daemon should boot and answer health without crashing. Without
`KORTIX_LLM_BASE_URL` and `KORTIX_TOKEN`, pi does not start: `harness.state` is
`"down"` and `harness.error` names the missing variables.

## Run it on your machine (`scripts/local.ts`)

`scripts/local.ts` runs a whole session on your computer and gives you a chat
REPL in the terminal. It needs no Kortix API and no sandbox provider. The model
is your ChatGPT Plus/Pro subscription.

```
bun apps/kortix-sandbox-agent-server/scripts/local.ts login      # once: ChatGPT sign-in in the browser
cd ~/some/project
bun ~/path/to/suna/apps/kortix-sandbox-agent-server/scripts/local.ts
```

Options: `--model codex/<id>` (default `codex/gpt-5.5`; `/models` in the REPL
lists them), `--workspace <dir>` (default: the current directory), `--fresh`
(drop the previous conversation of this workspace). In the REPL, `/model <id>`
switches the model, Ctrl-C aborts the turn, and Ctrl-D quits.

What it starts:

1. A local LLM gateway on `127.0.0.1`: `packages/llm-gateway` with local hooks.
   It sends every request to ChatGPT's Codex backend with the token `login`
   stored in `~/.kortix/local/codex-auth.json`, and refreshes that token.
2. kortixd from source, pointed at that gateway (`KORTIX_LLM_BASE_URL`), with
   `HOME=~/.kortix/local/home` so it never writes your own git config. State,
   `daemon.log` and `gateway.log` live in
   `~/.kortix/local/workspaces/<harness>-<hash>/`, so the next run in the same
   directory continues the same conversation.
3. A REPL over the Runtime API: `POST /kortix/runtime/sessions/:id/prompt` and
   the `GET /kortix/runtime/events` stream. It shows text, reasoning (dim), tool
   calls, questions and permission requests.

The agent's tools run as your user in the workspace directory. This is not a
sandbox. Tools that call the Kortix API (`web_search`, `scrape_webpage`, …) fail
without one.

## Management CLI

`kortixd` is a normal installable app. Its subcommands (`src/app/cli.ts`) manage the
binary's own lifecycle; the default (no subcommand) and `serve` boot the daemon.

| Command                          | Effect                                                            |
| -------------------------------- | ---------------------------------------------------------------- |
| `kortixd` / `kortixd serve`      | Run the sandbox agent server (default).                          |
| `kortixd version`                | Print version + build digest (the binary's own sha256).          |
| `kortixd install [--dir <path>]` | Install the binary onto PATH. Idempotent; `--force` overwrites.  |
| `kortixd update [flags]`         | Self-update to the current published build.                      |
| `kortixd rollback`               | Revert to the previous binary (`<name>.prev`).                   |
| `kortixd --health-check`         | Smoke-test: boot a health server on an ephemeral port, exit 0.   |
| `kortixd --help`                 | Usage.                                                            |

The daemon also keeps its pre-existing `git-credential` subcommand (git execs
it as a credential helper).

### Self-update reliability

`update` never bricks the app:

```
resolve target → verify content digest → smoke-test the new binary →
atomic swap (keep the replaced binary as <name>.prev) → post-swap health-check →
auto-rollback to <name>.prev on any failure
```

A half-written binary is never left on disk (write-to-temp + atomic
`rename(2)`). Exactly one previous version is kept for fast rollback.

### Boot sequence

The sandbox boot path runs, every start, idempotently:

```
kortixd install && kortixd update --boot && kortixd serve
```

- `install` is a fast no-op when the target already holds a binary (presence-
  based, so it never clobbers a binary that `update` already bumped).
- `update` does the ~700 B manifest/digest check FIRST and exits 0 with no
  download when the local binary already matches the target.
- `update --boot` is best-effort: any download/verify/health failure keeps the
  last-good binary and exits 0 so boot proceeds to `serve`. A bad publish never
  bricks a box; it serves stale-but-working and logs loudly. Manual
  `kortixd update` (no `--boot`) hard-fails non-zero instead.

### Bootstrap install

`install.sh` (curl | sh) is the one-line bootstrap that downloads the right
target binary and puts `kortixd` on PATH:

```
curl -fsSL https://<host>/kortixd/install.sh | sh
```

After it lands the first binary, `kortixd update` self-manages. Flags/env:
`--url`/`KORTIXD_URL`, `--base`/`KORTIXD_BASE_URL`, `--version`, `--dir`, and
`--from <path>` for an offline/local install.

### Relation to the sandbox supervisor

Inside a deployed box, `apps/sandbox/entrypoint.sh` is a shell supervisor that
performs the SAME kind of staged swap + crash-based rollback around the baked
`/usr/local/bin/kortix-agent` floor (via `agent.current` / `agent.next` /
`agent.prev` / exit code 75). The `kortixd update`/`rollback` subcommands bring
that reliability property into the binary itself so it works as a standalone app
on any machine, not only under the sandbox supervisor.
