---
name: evals
description: "The Kortix eval system (flag `evals`): Harbor-format tasks, suites under `evals:` in kortix.yaml, the trial runner on the worker, scoring, the Evals page, `kortix evals`, and the My Kortix benchmark in evals/my-kortix. Load before you change anything under apps/api/src/projects/evals, routes/evals.ts, worker/jobs/eval-runner.ts, packages/api-contract/src/evals.ts, packages/manifest-schema/src/evals.ts, the SDK evals client or hooks, apps/cli/src/commands/evals.ts, apps/web/src/features/workspace/evals or evals/; before you change My Kortix (run its benchmark before and after); and when an eval job hangs, errors or scores wrong."
---

# Evals

Agents are built against evals: tasks with a verifier that writes a score.
The product side (how a user writes tasks and climbs a score) is the managed
skill `packages/starter/templates/managed/skills/kortix-evals/SKILL.md`. This
file is how the system works and how to verify a change to it.

## The model (Harbor's, unchanged)

| Harbor | Kortix |
| --- | --- |
| task folder (`instruction.md`, `task.toml`, `environment/`, `tests/test.sh`, `solution/solve.sh`) | read as is from the project repo, a public git repo (`git_url`), the Harbor Hub (`org/name@ref`, a package archive) or the legacy Harbor registry (`name`, `version`) — `projects/evals/task-source.ts`, `hub.ts`, `harbor-task.ts` |
| job config (`n_attempts`, `agents`, `datasets`, …) | a suite under `evals:` or a `config:` file — `packages/manifest-schema/src/evals.ts` → `projects/evals/config.ts` |
| trial | one session (`source: system:eval`) and its sandbox — `projects/evals/runner.ts` |
| environment `docker_image` / Dockerfile | a project sandbox template `eval-<hash>` made on first use, reused after. A repo Dockerfile builds from its path; a Hub or git task's Dockerfile from its text (`sandbox_templates.dockerfile_inline`). No build context either way: `COPY`/`ADD` of a local file is refused (`contextFreeDockerfile`) |
| reward file, error policy, mean / pass@k | `projects/evals/scoring.ts` (Harbor's `error_policy.py` groups) |
| `jobs/<job>/<trial>/result.json` | Files `/Evals/<job>/<trial>/…`, written once by the API (`storage.ts`) |

`eval_jobs` / `eval_trials` are the index and the queue state; the job folder
in Files is the content.

## API rules (`routes/evals.ts`, `service.ts`)

- **Who reads what.** Jobs, trials, stats and compare need project read.
  Repository content — task lists, a task (`/tasks/{task_id}`), its files,
  its results, a trial's `instruction` — also needs `project.file.read`
  (a plain account member gets `403`, and `instruction: null`). Start,
  cancel, rerun and a trial retry/cancel need `project.session.start`.
- **Trial sessions run as the starter.** `eval_jobs.started_by` keeps the
  principal type, token kind and the session a token acts from; the runner
  creates every trial session with them. An agent's token makes each trial
  that session's child.
- **`task_id` is signed** (`task-id.ts`, HKDF of `API_KEY_SECRET`, bound to
  the project). The API mints it only from a suite, a built-in or the
  registry, so no client can make it fetch an arbitrary repository. The
  fetched-repo cache keeps the 24 most recently read repos.
- **Idempotency.** `POST /jobs`, `/rerun` and `/trials/{id}/retry` take
  `Idempotency-Key`: a replay answers `200` with the first result, the key
  with another body `409 eval_conflict` (`job_id` in the body).
- **`verifier.env` values are redacted** (`<redacted>`) in every read and in
  Files `config.json`. Do not put a secret there.
- **Ids that are no UUID** answer `404 eval_not_found`. Bad `limit`,
  `status` or `cursor` answer `422`.
- **pass@k** is Harbor's unbiased estimator (`scoring.ts`), computed when
  every reward value is 0 or 1 (any number of keys; a trial passes when
  every key is 1). A graded value leaves it empty; the metric still scores.
  Stats group by agent × model × source (`source` null for one source).
- **Retry one trial** inside its job (`/trials/{id}/retry`): the trial must
  have ended and be the last run of its attempt; an ended job reopens.
  **Rerun** makes a new job and refuses a job that has not ended (`409`).
- **Compare** (`GET /evals/compare?jobs=a,b[,…]&by=`) uses the last run of
  each attempt; `change` is the last job against the first. The CLI
  `compare` prints it.
- **No `harbor serve` control plane.** Kortix's API, CLI, SDK and MCP already
  are the control plane. Pause/resume, soft cancel and a cross-job trial list
  shipped in #12748 and were removed again: Kortix jobs run minutes, cancel
  plus rerun or a trial retry covers them, and the job and task pages show
  every trial. Do not add them back without a real use.

## Trial lifecycle (runner.ts, one leader tick every 3 s busy / 15 s idle)

`queued → starting` (session created; id stored first, so a lost create is
found, not repeated) `→ agent_running` (the turn ledger `session_turns` says
when the agent stopped; `oracle` runs `solution/solve.sh` detached instead)
`→ verifying` (`/tests` uploaded only now, `/logs/agent/response.md` = the
agent's last reply, verifier env gets `KORTIX_SESSION_ID`,
`KORTIX_EVAL_JOB_ID`, `KORTIX_EVAL_TRIAL_ID`, `KORTIX_FEATURE_FLAGS`)
`→ completed | errored | cancelled`. Every step is short and repeatable.

Sandbox commands go through the PROVIDER exec (`box.ts`), as root, never the
in-box daemon. Two rules learned on 2026-11-13:
- A detached command must reach its own session before the exec returns:
  `launch` waits until the wrapper wrote its pid. A plain `nohup … &` child
  died with the exec call.
- One copy of a script per command: Linux caps one argument at 128 KiB.
  Upload chunks are 48 KiB.

Each tick also stops the sandbox of any ended trial that still runs (a
cancel that landed during session create).

Rules learned on 2026-11-14, running the My Kortix benchmark:
- **Grade when the session is quiet**, not at the end of the first turn: an
  agent that hands work off (My Kortix) answers after its colleagues report.
  `colleaguesQuiet` waits until every descendant session has no open turn
  and none is still starting, for 30 s, inside the agent timeout. Ending a
  trial stops its colleagues' sandboxes too.
- **Every trial is a top-level session.** A child session runs another
  harness (no follow-through check, no goal mode), so a job an agent started
  would score a harness nobody uses.
- **A provider rate limit is not a trial failure.** Platinum answers `429`
  above 20 writes a second per org; `box.ts` waits its `retry-after` up to 5
  times. Ten trials starting at once hit it.
- **A local runner loop compiles the My Kortix prompt** into each session it
  creates, and it does not hot-reload: restart it after a prompt change, or
  every trial runs the old prompt. (Deployed, the worker ships with the API.)
- **Trials share the job's workspace unless the task asks for its own.** A
  grader that reads workspace state then sees other trials' triggers and
  invites. A task that grades workspace state sets
  `[metadata.kortix] workspace = "fresh"` (below).

## A fresh workspace per trial (`trial-workspace.ts`)

`[metadata.kortix] workspace = "fresh"` gives every trial a workspace of its
own. A workspace is one account and its project, so it is an account of its
own, owned by the person who started the job:

1. `kortix.eval_trial_workspaces` gets the row first: the workspace switcher
   (`listUserWorkspaceCandidates`) leaves the account out, and notifications
   about it are dropped (`notifier.ts` `silentAccount`).
2. The account, with an id derived from the trial (a retried create
   converges), never the person's one free credit grant.
3. Money: the job's workspace pays. The trial's budget (`budget_usd`, default
   $2) moves out of the job's account and into the trial's (wallet keys
   `eval-trial-budget-out|in:<trial_id>`). The trial account gets the Credits
   plan when the job's account may use the Kortix models. When the trial
   ends, the unspent budget goes back at once (`eval-trial-release-*`), so a
   job holds only the budgets of the trials that run; at teardown the charges
   that landed since are squared (`eval-trial-final-*`). An overspend is
   charged to the job's account and the trial account brought back to zero.
   A dev run of 34 trials at 8 at a time ran out of a $45 balance while
   teardown alone returned the budget (2026-11-16).
4. The project from the `minimal` starter (My Kortix and `worker`), no
   prebuild and no `project_created` event (`runProvision` `evalTrial`).
5. The job workspace's flags plus the task's `requires_flags`.
6. The task's `environment/workspace/` files, committed on top.

The session is the person's own chat there: source `eval:trial`, origin
`user`, private, so it has their Drive and My Kortix's memory, the harness a
person gets. (In the job's workspace a trial stays `system:eval`, origin
`system`: an unattended job never reaches the person's real Drive.) The
runner's sweep deletes the workspace 10 minutes after the trial ended, so late
compute and model charges land on it first: its Apps (account deletion stops
sessions, not App machines), then the money, then `deleteAccountImmediately`.
A fresh-workspace task cannot name a `docker_image` or a Dockerfile: the trial
runs the agent's own sandbox.

## Multi-step tasks (Harbor `[[steps]]`)

`steps/<name>/{instruction.md,tests/test.sh,solution/solve.sh,workdir/}`, run
in order. Kortix differs from Harbor in one way: every step continues the same
session (a Kortix agent is a chat, so a later step is the person's next
message, never a new agent in the same sandbox).

- `workdir/` is copied into the working directory and `workdir/setup.sh` runs
  there before the step's message, then is removed (the agent never reads how
  its task was staged). It and `solve.sh` run as the agent's user (`[agent]
  user`, else `kortix`) with the agent's environment
  (`/dev/shm/kortix/agent-env.sh`), so `kortix` acts as the session.
- Each step's tests replace the step before's in `/tests`; each script has
  its own in-sandbox job id per step (a launched job never runs twice).
- The trial stops after a step whose verifier wrote no reward, after an agent
  error, or below the step's `min_reward`. The trial's reward is
  `multi_step_reward_strategy` (`mean`, Harbor's default, or `final`) over the
  steps that ran; each step's result is in `result.json` `step_results` and
  its logs under `steps/<name>/` in the trial folder.
- A later step's turn is the first that started after its message (`firstTurn`
  `since`); its timeout counts from the message.
- Not yet: a step's own healthcheck, artifacts or separate verifier (refused
  with a reason).

## Verify a change locally

1. `pnpm worktree start evals --no-web` (or your worktree). A worktree stack
   runs no singleton workers, so start the runner tick yourself in a loop
   with the API process's environment: import `src/app`, call
   `prepareProcess({ entry: true })` (it loads the model lineup; without it
   every trial fails `No model`), then `runEvalRunnerTick()` every few
   seconds.
2. Mint a user (CLAUDE.md "Authenticating"), turn on the flag:
   `PATCH /workspaces/:id/features {"feature":"evals","enabled":true}`.
3. Commit tasks + an `evals:` suite, then drive it with the real CLI
   (`KORTIX_API_URL`, `KORTIX_TOKEN`, `KORTIX_PROJECT_ID`, `KORTIX_FEATURE_FLAGS=evals`):
   `kortix evals run smoke --wait`, `show`, `compare`, `trial … --file verifier/test-stdout.txt`.
4. A change is proved when `oracle` scores 1 and `nop` 0 on every task,
   and a model agent's trial shows real token usage.
5. REST contract: `pnpm test -- --id EVAL-1` (no sandbox; planning, dry
   run, idempotency, task pages and the file-read gate, filters and paging,
   compare, trial cancel/retry, cancel, rerun, delete).

## The My Kortix benchmark

`evals/my-kortix/` is one task per My Kortix capability (agents, colleagues,
triggers, connectors, secrets, memory, Drive, Apps, documents, code, research,
browser, media, evals, permissions, asking first, follow-through), each in a
fresh workspace and graded on the state it leaves (its README has the table
and how a grader is written). Run it before and after any change to My Kortix
(its prompt `apps/api/src/projects/lib/my-kortix-prompt.ts`, its skills, its
model) and put both scores per capability in the PR.

It is a built-in dataset: every project can name it, and it is read from the
Kortix repository at the commit the API was built from (`version` pins
another commit, branch or tag, e.g. your branch while you change the tasks):

```yaml
evals:
  my-kortix:
    datasets:
      - name: kortix/my-kortix
        version: <your branch>   # optional
    agents: [mykortix]
    n_attempts: 3
```

Built-in datasets are listed in `BUILTIN_DATASETS`
(`apps/api/src/projects/evals/task-source.ts`); add one there for every
folder of tasks Kortix ships. Every `solution/solve.sh` must score 1 and
`nop` 0: run the dataset with `oracle` and `nop` after any task change.

The 20 reply-graded tasks of 2026-11-13 were replaced on 2026-11-16: they
graded what My Kortix said, in a workspace every trial shared. Their
hill-climb (the "ask, then stop" rule) is in git history (#12682).

The next tasks and graders (collateral-damage checks, prompt injection,
should-not-ask controls, noisy workspaces, proactivity, graded deliverables),
the 2026 agent-eval research behind them, and the open failures the benchmark
found are in `.agents/skills/learnings/work/agent-benchmark-expansion/`. The
plan to let agents grow their own evals is in
`.agents/skills/learnings/work/continual-learning/`.

## Not supported yet

Docker-compose environments, a restricted network
(`no-network`/`allowlist`, `allow_internet = false`: Kortix cannot enforce it),
`mcp_servers`, a Dockerfile that copies local files, Windows, GPUs,
`metric.py`, Harbor's Python agents (`import_path`), and `harbor serve` (see
API rules) with its SQL `/query` and Hub upload. Each is refused with a reason
(`TaskUnsupportedError`, a validation issue), never run wrong.

Supported since 2026-11-14 (Harbor v0.26.0): the Hub registry, a separate
verifier (`artifact-transfer.ts`), `[environment.healthcheck]`, `artifacts`
(`artifacts.ts`), `.harborignore`, and Dockerfile tasks from outside the
repository. Since 2026-11-16: multi-step tasks (`[[steps]]`) and a fresh
workspace per trial.
