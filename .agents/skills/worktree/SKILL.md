---
name: worktree
description: "How to do feature work in this repo with git worktrees via `pnpm worktree`. Each worktree gets its own branch, its own block of app ports, its own node_modules, and by default shares the primary checkout's standard local Supabase DB for fast setup; pass `--db` for its own database (a copy of the primary inside the same Postgres) when the work needs migrations or destructive data changes. Load WHENEVER starting a feature, bugfix, refactor, experiment, or any change you'll want to run/test in isolation; whenever the user mentions worktrees, isolated/parallel dev instances, running multiple branches at once, or 'spin up a worktree'; and whenever you need the exact non-interactive `pnpm worktree` commands and flags. Enforces: one canonical branch per objective, one worktree per branch — join the existing worktree instead of creating another."
---

# Worktrees (`pnpm worktree`)

Multi-instance dev environments for this monorepo. One command from a clean
checkout provisions a collision-free app stack on its own branch: unique ports
for web/api/gateway, its own `node_modules` + pnpm store, and a tunnel for cloud
sandbox callbacks. By default the worktree uses the primary checkout's standard
local Supabase DB (`kortix-local` on 54321/54322) so setup is fast and auth/data
state is shared. Pass `--db` when the work needs its own schema or data
(migrations, destructive data changes): it copies the primary into its own
database `kortix_wt_<n>` in the same Postgres (~5 s, no extra containers).
Pass `--full-supabase` only when the work needs its own auth or storage
config: that runs a whole Supabase project (8 containers, ~0.75 GB RAM). The CLI lives
at `scripts/worktree/cli.ts`, run via the root `package.json` script
`pnpm worktree`.

## THE RULE — one canonical branch, one worktree

**A worktree maps 1:1 to a canonical branch** — the branch for whatever is being
worked on. Work in a worktree, but **do not create one by reflex.**

**First, look for the worktree that already exists.** Run `pnpm worktree list`.
If the work continues, extends, fixes, or cleans up something already in flight,
it belongs in that worktree, on that branch. Join it. Spinning a second worktree
for the same objective is the mistake this rule exists to prevent.

**Never switch a worktree you did not create to another branch.** Another
session may be working in it. The pre-commit hook refuses a commit whose branch
is neither the worktree's own (`.kortix-worktree.json`) nor `<branch>/…`
(`scripts/check-worktree-branch.sh`; deliberate override:
`KORTIX_WORKTREE_ANY_BRANCH=1`). A throwaway probe branch gets a private
`git worktree add <scratchpad>/<name>` instead.

**Create a new worktree only when the work is genuinely a new thing.** Use
shared-DB mode for ordinary UI/API work; opt into `--db` when database isolation
is materially required, and into `--full-supabase` only for auth/storage config.

**Pack more into the branch, not less.** Follow-up fixes, rename cleanups, and
stale-reference sweeps belong on the same branch as the change that caused them,
and land together. Sub-branches off the canonical branch are fine — they merge
back into it, and never open a PR against `main`.

Carve-outs (a worktree is *not* required):
- Read-only investigation / answering questions.
- A trivial single-file typo/comment fix on the branch you're already on.
- Operating on the primary `pnpm dev` stack itself.

Shared-DB worktrees are cheap and `nuke` removes only the app worktree
resources; isolated-DB worktrees also clean up their Supabase containers and
volumes.

> **Session start:** the repo-root `AGENTS.md` ("First, at session start: which
> canonical branch are you in?") governs. Join the existing canonical branch when
> one exists; ask the user which branch when it is not obvious.

## Agent quick start (non-interactive, non-blocking)

```sh
pnpm worktree create --name <feat> --yes --no-start
```

- `--name <feat>` names the worktree (letters/numbers/dashes; lowercased).
- `--yes` auto-installs any missing toolchain deps and skips prompts.
- Uses the shared primary Supabase DB by default. Add `--db` for work that
  needs its own database (migrations, destructive data work).
- **`--no-start` is mandatory for agents** — without it, `create` ends by
  booting the dev servers **in the foreground and blocks until Ctrl+C**, which
  will hang your turn. `--no-start` provisions everything and returns.

The new checkout lands at a **sibling** of the repo: `../suna-<feat>`
(e.g. repo `…/kortix/suna` → worktree `…/kortix/suna-<feat>`). It is on a **new
branch `<feat>`** auto-created from your current `HEAD`. Do all subsequent
edits, `git`, and runs against that path:

```sh
WT=../suna-<feat>          # resolve to an absolute path in practice
# edit files under $WT, then:
git -C "$WT" add -A && git -C "$WT" commit -m "..."
```

When the branch is merged/pushed and you're done: `pnpm worktree nuke <feat>`.
In shared-DB mode this leaves the primary Supabase DB running and untouched.

## How `--db` works (branch database)

- `create` copies the primary's `auth`, `basejump`, `kortix*` and `public`
  schemas into `kortix_wt_<n>` (`-` becomes `_`) inside the primary Postgres.
  Audit-event rows are skipped. Then it applies this branch's
  `packages/db/migrations` with `pnpm --filter @kortix/db migrate:local`.
  `start` applies newly pending migrations again.
- GoTrue, Kong, Storage and Studio stay shared. Sign in with the same users as
  the primary. The API's `DATABASE_URL` points at `kortix_wt_<n>`, so accounts,
  projects and sessions created in the worktree exist only there.
- A trigger on the primary's `auth.users` pushes every user insert, update and
  delete into each branch database (`kortix_wt.branches`, dblink). `create` and
  `start` also reconcile the full user list. A failed push never fails sign-up;
  it logs `kortix_wt: … failed` in the primary's Postgres log
  (`docker logs supabase_db_kortix-local`), and the next `start` repairs it.
- Each branch database has its own work queue, so the shared-DB tunnel
  crosstalk warning does not apply.
- `nuke` drops the database. `create <n> --db` on an old `--full-supabase`
  worktree moves it to a branch database and deletes its Supabase containers
  and volumes (TTY confirm unless `--yes`).
- Inspect it: `psql postgresql://postgres:postgres@127.0.0.1:54322/kortix_wt_<n>`,
  or switch the database in Studio (`http://localhost:54323`).

## All commands (non-interactive)

Run bare `pnpm worktree` (TTY) for an interactive menu; everything below is the
scriptable form. `<n>` = worktree name. Aliases shown with `|`.

### `create` (alias `new`) — provision a worktree

```sh
pnpm worktree create --name <n> [flags]
pnpm worktree create <n>        [flags]   # positional name also works
```

| Flag | Default | Effect |
| --- | --- | --- |
| `--name <n>` / positional `<n>` | — (required) | Worktree name → branch name + slot identity. |
| `--branch <b>` | `<n>` | Branch to use. A local branch is checked out; a branch that exists only as `origin/<b>` (run `git fetch` first) is checked out tracking it; otherwise it is created from `--from`. |
| `--from <ref>` | `dev` | Base ref for a newly created branch. `dev` means a freshly fetched `origin/dev`, never the primary checkout's local `dev`, which is often hundreds of commits behind. The new branch has no upstream, so push it with `git push -u origin <branch>`. Must carry current `packages/db/migrations` (see above). |
| `--db` / `--with-db` / `--isolated-db` | off | Own database `kortix_wt_<n>` inside the primary Supabase: a copy of the primary, migrated to this branch. See "How `--db` works". |
| `--full-supabase` | off | A whole separate Supabase project (`kortix-wt-<n>`) with its own containers/volumes/migrations. Only for auth/storage config work. |
| `--no-db` / `--shared-db` | on | Explicitly use the default shared primary Supabase DB. |
| `--no-start` | off | **Provision only, don't boot servers.** Use this for agent/CI runs. |
| `--yes` | off | Auto-install missing deps; non-interactive. |
| `--no-tunnel` | off | Skip the Cloudflare tunnel (offline; cloud sandboxes won't be reachable). |
| `--no-web` | off | Boot without `next dev` (also on `start`). Use it for API/CLI-only work; each `next dev` holds GBs of RAM. Open the UI later with `pnpm worktree web <n>`. |

What it does, in order: `autoclean`, the disk guard and the 15-min schedule (see `autoclean` below;
exit `2` below 4 GB free) → toolchain preflight → allocate the lowest slot that no
registered worktree holds and whose whole port block is free (one `lsof` scan, up
to 100 unregistered slots, the first 5 clashes logged) → `git worktree add` (new branch from
`--from`, or checkout existing `--branch`) → `pnpm install` into the worktree's
own store → build runtime artifacts → (unless `--no-start`) boot the stack
against the shared primary Supabase DB. With `--db`, it also copies the primary
into `kortix_wt_<n>`, applies the branch's migrations, verifies the `kortix`
schema exists, and syncs `auth.users`. With `--full-supabase`, it renders an
isolated Supabase project, starts it, applies migrations, and starts that
Supabase stack. Re-running `create` for an existing name resumes it
idempotently. A worktree's DB mode is fixed until you `nuke` and recreate it;
the one exception is `--db` on a `--full-supabase` worktree (see above).

### `start` — boot an existing worktree (FOREGROUND, BLOCKS)

```sh
pnpm worktree start <n> [--stripe] [--no-tunnel] [--no-web]
pnpm worktree web <n> [--billing]   # only `next dev`, for a stack started with --no-web
```

First runs `autoclean`, the disk guard (warn only) and the 15-min schedule check, then deletes an `apps/web/.next` over the 3 GB cap. In shared-DB mode, ensures the primary local Supabase is reachable, checks that
the `kortix` schema exists, then runs **api + web in the foreground and blocks
until Ctrl+C**. In `--db` mode, applies the branch's pending migrations to
`kortix_wt_<n>` and reconciles `auth.users` first (and re-copies the primary if
the database is missing). In `--full-supabase` mode, starts that worktree's
Supabase, applies pending migrations, then boots the app stack. Clean shutdown stops the worktree
app servers, force-kills stragglers, and marks the worktree stopped. Requires
Docker running when Supabase needs to be reached or started.

- **Agents:** do not call this inline — it will hang the turn. If you need the
  stack running to test, launch it as a background process and poll, or ask the
  user to run `pnpm worktree start <n>` in their own terminal.
- A Cloudflare quick tunnel starts by default so cloud (Platinum) sandboxes can
  call back to the local API (`KORTIX_URL` → the `*.trycloudflare.com` URL).
  `--no-tunnel` skips it; if `cloudflared` is missing it warns and continues.
- `--stripe` turns billing **on** for the worktree and runs `stripe listen`
  forwarding test-mode webhooks to *this* worktree's API
  (`…:<api>/v1/billing/webhooks/stripe`), injecting the `whsec_…` signing secret
  so signatures verify. Needs the `stripe` CLI logged in (`stripe login`) and a
  test `STRIPE_SECRET_KEY` in the worktree's local `.env` (billing won't boot
  without it). Lets you exercise checkout/subscription/webhook flows end-to-end
  in isolation.

### `stop` — pause a worktree (keeps data)

```sh
pnpm worktree stop <n>
pnpm worktree stop --all      # every worktree at once
```

Kills the web/api/gateway **process trees** — the dev servers plus the ~15 workers
each one forks, the Cloudflare tunnel, and `stripe listen` — then verifies they are
gone before recording the stop. Shared-DB mode leaves the primary Supabase running.
Isolated-DB mode also stops the worktree's Supabase. Data (DB volume for isolated
mode, branch, files) is preserved; `start` resumes it.

**Stop what you are not using.** A stack holds ~19 processes and a few GB that
Turbopack never gives back, so a handful of forgotten stacks will exhaust swap and
get something OOM-killed. `stop --all` is the end-of-day sweep and the way back
from stacks orphaned by an OOM kill (their supervisor is gone, so there is no
`Ctrl+C` left to press). `pnpm worktree doctor` shows what is actually running,
including worktrees whose recorded status has drifted from reality.

### `nuke` (alias `rm`) — tear down and free the slot

```sh
pnpm worktree nuke <n> [n2 …] [--force] [--yes]
pnpm worktree nuke            # TTY: pick from a list, then confirm each
```

Accepts one or many worktree names. **Every target is confirmed individually**
before anything is destroyed (default **No** — answer no to skip one,
Esc/Ctrl+C to stop the rest); `--yes` or a non-TTY stdin skips the prompts for
scripts and agents. Bare `pnpm worktree nuke` in a TTY shows the worktree list
to multi-select targets from (space to select, enter to confirm); the
interactive menu (`pnpm worktree` → nuke) uses the same picker.

Stops servers, removes the git worktree, **deletes the branch**, drops the slot,
and frees the app ports. In shared-DB mode it does **not** stop or delete the
primary Supabase DB. In `--db` mode it drops `kortix_wt_<n>`. In
`--full-supabase` mode it also stops Supabase and removes that worktree
project's Docker containers/volumes/network. By default the branch is
deleted with `git branch -d` (safe — refuses if unmerged); `--force` uses
`git worktree remove --force` **and** `git branch -D` (drops unmerged commits).
Only `nuke` after the work is merged or pushed.

### `nuke --all` — bulk teardown with time rules

```sh
pnpm worktree nuke --all [--older-than <dur>] [--idle <dur>] [--include-dirty] [--dry-run] [--yes]
pnpm worktree nuke --all --older-than 2d --yes      # everything created >2 days ago
pnpm worktree nuke --all --idle 12h --dry-run       # preview: nothing touched in 12h
```

Scans every registry slot, prints one `keep`/`nuke` line per worktree with the
reason, then tears down the selected ones with the same per-worktree `nukeOne`
path as `nuke <n>` (stack stop, isolated-DB Docker cleanup, `git worktree
remove`, `git branch -d`, slot freed). Selection rules, in order:

- a **running** stack (web or api port answering) is always kept;
- a slot whose **directory is missing** is always freed;
- **uncommitted changes** (tracked or untracked, except the generated-noise
  files in `NOISE_PATHS`) keep the worktree unless `--include-dirty`;
- `--older-than <dur>` compares the registry `createdAt`;
- `--idle <dur>` compares last activity, defined as for `autoclean` below.

Durations are `<n>m|h|d|w` (`30m`, `12h`, `3d`, `2w`). Both time rules must
pass when both are given. With no time rule every stopped, clean slot is
selected. A TTY asks for one confirmation for the whole batch; `--yes` or a
non-TTY stdin skips it. Local branches survive as with `nuke <n>` (`-d` only,
`--force` for `-D`), so committed work is never lost — only the checkout and
its `node_modules` go. `bun` reads stdin: when calling from a shell loop, pass
`</dev/null`.

### `pr` — push the branch and open a pull request

```sh
pnpm worktree pr <n> [--title "…"] [--body "…"] [--base main] [--repo owner/name] [--draft] [--web]
```

Closes the loop (create → work → `pr`). Refuses if the branch has no commits
ahead of `--base` (default `main`); warns if the tree is dirty (uncommitted work
won't be in the PR). Pushes `origin/<branch>` (`-u`), then runs `gh pr create`.
Title/body come from the branch's commit messages via `gh --fill` unless
`--title` is given. `--draft` opens a draft; `--web` finishes in the browser.
If `gh` isn't installed it still pushes and prints a compare URL. On a fork, gh
may ask which base repo — answer the prompt (or pass `--repo`). Requires the
push remote (`origin`) to be authenticated for your account.

### `list` (alias `ls`) — every worktree and its ports

```sh
pnpm worktree list           # all of them, running first then alphabetical
pnpm worktree list md        # substring filter
pnpm worktree list --json    # machine-readable, for scripts and jq
```

One line per worktree: live status, name, and its web/api ports, with a dot
leader between the name and the port so the eye cannot slip a row. Both ports
are OSC 8 hyperlinks — ⌘-click them in a supporting terminal.

Status is a **real listening-port scan** (one `lsof` for the whole box, ~40ms),
not the registry field, so it cannot go stale the way a recorded status can. If
`lsof` is unavailable the command falls back to the registry and says so in the
footer. `list` never writes the registry — `doctor` owns drift repair.

Constants live in the footer instead of in every row: the shared Supabase
db/studio ports, the counts, and — when any worktree runs `--full-supabase` — a note that
DB modes are mixed.

A filter matching exactly one worktree expands into full clickable URLs:

```
  ○ md-table  slot 19 · stopped · shared db

    web     http://localhost:14900
    api     http://localhost:14908/v1
    studio  http://localhost:54323
    path    /Users/you/root/kortix/suna-md-table
```

### `status` — live health

```sh
pnpm worktree status [<n>]    # all worktrees, or just <n>
```

Per-worktree: whether web/api ports are listening and whether its configured
Supabase target is up.

### `doctor` — verify toolchain + integrity

```sh
pnpm worktree doctor [--yes]
```

Checks required tools (bun, node >=22, pnpm, dotenvx, plus Supabase/Docker/psql
for DB modes) and the optional `cloudflared`, then flags any worktree whose dir
is missing, isn't a registered git worktree, or has orphaned isolated-DB
containers, and any slot two worktrees share (allocators before 2026-10-15 could
reuse a registered slot; nuke and recreate all but one). `--yes` auto-installs
missing deps.

### `sweep` — reclaim disk from idle checkouts

```sh
pnpm worktree sweep              # dry run: what would go, and how many GB
pnpm worktree sweep --yes        # delete it
pnpm worktree sweep --idle 1d --yes
```

Deletes `.next`, `.turbo`, `dist`, `target`, `test-results` and
`playwright-report` in every git worktree of the repo (registered or not,
scratchpad checkouts included). It skips a checkout with a process inside it or
naming it on its command line, or any file written within `--idle` (default
`60m`). It keeps any dir that holds a tracked file (`packages/ui/dist`). Run it
first when the disk is full: build output is the largest lever. `apps/web/.next`
grows without bound under `next dev` (3.4 GB and 7.0 GB in two checkouts on
2026-11-10). Removing a worktree frees its build output plus ~1.3 GB of unshared
files; its 5.6 GB `node_modules` is mostly hardlinks into the pnpm store.

### `autoclean` — automatic housekeeping (create, start, and every 15 min)

```sh
pnpm worktree autoclean --dry-run       # what it would do, per checkout, with sizes
pnpm worktree autoclean --yes           # do it now
pnpm worktree autoclean --install-cron  # (re)install the 15-min schedule now, even after --uninstall-cron
pnpm worktree autoclean --uninstall-cron
```

`create` and `start` run it first, with no prompt, and keep the 15-minute
schedule installed (see below). It prints one summary line, or nothing when
there is nothing to do. It covers every registry slot and every Claude Code
isolation worktree (`git worktree list` entries under
`<primary>/.claude/worktrees/`):

| State | Action |
| --- | --- |
| primary checkout, running stack, a process inside or naming it, a directory `git worktree list` does not name, or any other git worktree | never touched |
| Claude isolation worktree locked by a live agent (`claude agent … (pid P start S)`, pid P alive with start S), or locked with any other reason | never touched |
| build output dir (`ARTIFACT_DIRS`, mostly `apps/web/.next`) > 3 GB, stack not running, no process in its package, no write in 10 min | that dir deleted, however recently the checkout was used |
| idle ≥ 24h | build output deleted, as `sweep` |
| idle ≥ 24h, no real changes, branch **merged** into dev | worktree removed; branch deleted |
| idle ≥ 48h, no real changes, every commit of HEAD and its branch on a remote | worktree removed; branch deleted |
| idle past the threshold with real changes, or commits on no remote and not merged | kept, build output swept |
| registry slot whose directory is gone, idle ≥ 48h | slot freed |
| local `worktree-agent-*` branch with no worktree, every commit on a remote or merged | branch deleted |

- **Merged** = the tip is in `origin/dev`; or a merged PR from
  `gh pr list --state merged --limit 500` (cached 10 min in
  `$KORTIX_HOME/worktrees/merged-prs.json`) has the tip as its head, or the
  tip adds only pushed commits to that head; or, when `gh` is unavailable,
  every file the branch changed is identical in `origin/dev`. A squash-merged
  branch whose remote branch was deleted therefore no longer counts as
  "unpushed" forever. A branch name reused for new work is not merged.
- **Stale Claude lock:** the agent pid is gone or its start time differs
  (reused pid). The lock is lifted, then `git worktree remove` runs without
  `--force`, so a checkout with changes can never go.
- **Pressure mode** (free space < 15 GB): build output is swept in every
  stopped, unbusy checkout regardless of idle time; removal drops to 12h; and
  the machine caches are trimmed: `pnpm store prune` (the store all worktrees
  share), `go clean -cache`, `bun pm cache rm`, `npm cache clean --force`.
  The trims are skipped while a package install or go build runs. The summary
  line prints free space before and after.
- **Activity** = newest of registry `createdAt`, registry `lastUsedAt`
  (`create`, `start`, `web` and `stop <n>` write it), the HEAD commit time,
  and the mtime of each changed file. A Claude worktree uses the mtimes of its
  admin dir (`.git/worktrees/<id>`: HEAD, lock) instead of the registry. A
  read never counts: probes run `git --no-optional-locks`.
- **`start` caps first:** an `apps/web/.next` over the cap is deleted before
  the stack boots. The first page then compiles cold.
- **Generated noise:** `NOISE_PATHS` in `scripts/worktree/lib/autoclean.ts`
  (today `apps/web/src/lib/seo/content-timestamps.json`, which `next dev`
  rewrites). A change only there is clean; removal restores the file first.
- **The worktree the command runs for** is never removed. Every rule is
  re-checked right before each delete. Autoclean kills no process.
- One autoclean runs at a time per machine (`$KORTIX_HOME/worktrees/autoclean.lock`).

| Env | Default | Effect |
| --- | --- | --- |
| `KORTIX_WORKTREE_AUTOCLEAN=0` | on | Turns off the automatic run and the schedule install on `create`/`start`. The explicit command still works. |
| `KORTIX_WORKTREE_SWEEP_IDLE` | `24h` | Idle time before build output is swept. `<n>m\|h\|d\|w`. |
| `KORTIX_WORKTREE_REMOVE_IDLE` | `48h` | Idle time before a clean, pushed worktree is removed. |
| `KORTIX_WORKTREE_MERGED_REMOVE_IDLE` | `24h` | Same, for a merged branch. |
| `KORTIX_WORKTREE_NEXT_CAP_GB` | `3` | Size cap for one build output dir. |
| `KORTIX_WORKTREE_PRESSURE_GB` | `15` | Pressure mode below this free space. |
| `KORTIX_WORKTREE_PRESSURE_REMOVE_IDLE` | `12h` | Remove threshold in pressure mode. |
| `KORTIX_WORKTREE_DISK_WARN_GB` | `10` | Disk guard warn level. |
| `KORTIX_WORKTREE_DISK_REFUSE_GB` | `4` | Disk guard refuse level. |

**Disk guard.** After autoclean, `create` and `start` read the free space of
the filesystem that holds the worktrees (`df -Pk`). Below 10 GB they warn and
list the 5 largest registered checkouts (unshared size and `.next` size). Below
4 GB `create` exits `2` and names `pnpm worktree autoclean --yes`, `sweep` and
`nuke --all`; `start` only warns.

**The 15-minute schedule (automatic).** The scheduled run executes a
standalone bundle, `$KORTIX_HOME/bin/worktree-autoclean.js` (built with
`bun build scripts/worktree/cli.ts --target bun`, no `node_modules` needed),
against the primary checkout named explicitly
(`--repo <primary>`, `KORTIX_WORKTREE_REPO`). It does not depend on the
primary checkout's version. `create` and `start`:

1. rebuild the bundle when it is missing, when it was built from uncommitted
   code, or when the last commit that touched `scripts/worktree` in the
   running checkout is newer than the bundle's (`$KORTIX_HOME/bin/worktree-autoclean.js.json`).
   Older code never downgrades it; uncommitted code never replaces it on its own.
   The new bundle must run `bundle-check` from `/` before it replaces the old one.
2. install the schedule when it is missing or runs another command:
   - **cron** when a cron daemon runs (macOS always): one line, `*/15 * * * *`,
     marked `# kortix-worktree-autoclean`;
   - otherwise (PTXP boxes have no cron daemon) a detached `sh` loop started
     with `setsid`, which sleeps 15 min, runs, and exits on its own when
     `$KORTIX_HOME/worktrees/autoclean-loop.gen` no longer holds its
     generation. A reinstall writes a new generation; it never kills a process.
     A reboot ends the loop; the next `create`/`start` starts it again.

Each scheduled run fetches `origin/dev`, appends to
`$KORTIX_HOME/worktrees/autoclean.log` (rotated to `.1` above 1 MB) and runs
`autoclean --yes --quiet`. `--uninstall-cron` removes the cron line, retires
the loop (it exits at its next tick, ≤ 15 min) and writes
`autoclean-schedule.off` so `create`/`start` stop reinstalling;
`--install-cron` removes that file and installs now.

## Kortix Capture in a worktree

A worktree's API stores Kortix Capture objects in its own Supabase Storage
(bucket `kortix-capture`). Device credentials need STS, which Supabase Storage
lacks: run MinIO and point the API at it with
[references/capture-local-store.md](references/capture-local-store.md).

## What each worktree isolates

| Resource | Primary `pnpm dev` | Worktree slot N |
| --- | --- | --- |
| web | 3000 | **13000 + N·100** |
| api | 8008 | **13008 + N·100** |
| Supabase API / DB / Studio / Inbucket | local default | shared default and `--db`: 54321 / 54322 / 54323 / 54324; with `--full-supabase`: 13321 / 13322 / 13323 / 13324 (+N·100) |
| Supabase project | `kortix-local` | shared default: `kortix-local`; with `--db`: `kortix-local`, database `kortix_wt_<n>`; with `--full-supabase`: `kortix-wt-<n>` (own containers/volumes/network) |
| branch | your current branch | dedicated `<n>` (or `--branch`) |
| deps | repo `node_modules` | own `node_modules` + pnpm store |

Slot 0 → web 13000 / api 13008 / gateway 13090; slot 1 → web 13100 / api 13108 /
gateway 13190; and so on. Isolated DB ports follow the same stride. Slots are
assigned lowest-free and skip any app port already in use, so worktrees never
collide with each other or with `pnpm dev`.

## State & layout

- Checkout: `../suna-<n>` (sibling of the repo root).
- Control state: `~/.kortix/worktrees/` — `registry.json` (the slot ledger) and
  a per-worktree dir holding the rendered Supabase config (`sb/`) and pnpm store.
  Lives entirely outside any checkout, so nothing dirties a tracked tree. Set
  `KORTIX_HOME` to relocate it.
- In-worktree marker: a gitignored `.kortix-worktree.json` (slot/ports/project/DB mode).

## Scope & safety

This is **local-dev tooling only** (`scripts/worktree/*`, invoked via `pnpm
worktree`). It is not imported by any app, build, CI, or Docker image, and it
never touches cloud/production infrastructure — production reads its env from
AWS Secrets Manager, a separate path. The tunnel and `KORTIX_URL` injection
affect only the locally-spawned worktree API process.
