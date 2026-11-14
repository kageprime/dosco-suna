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
| task folder (`instruction.md`, `task.toml`, `environment/`, `tests/test.sh`, `solution/solve.sh`) | read as is from the project repo, a public git repo (`git_url`), or the Harbor registry (`name`, `version`) — `projects/evals/task-source.ts`, `harbor-task.ts` |
| job config (`n_attempts`, `agents`, `datasets`, …) | a suite under `evals:` or a `config:` file — `packages/manifest-schema/src/evals.ts` → `projects/evals/config.ts` |
| trial | one session (`source: system:eval`) and its sandbox — `projects/evals/runner.ts` |
| environment `docker_image` / repo Dockerfile | a project sandbox template `eval-<hash>` made on first use, reused after |
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
- **Trials share the workspace.** A grader that reads workspace state sees
  other trials' triggers and invites; read the trial session's own tool calls
  (`kortix sessions log --json`, call inputs only).

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

`evals/my-kortix/` holds tasks for what people ask My Kortix to do. Run it
before and after any change to My Kortix (its prompt
`apps/api/src/projects/lib/my-kortix-prompt.ts`, its skills, its model) and
put both scores in the PR:

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
folder of tasks Kortix ships.

Each task tests a rule of My Kortix's prompt; the README table names it.
Every judged task pins `KORTIX_EVAL_JUDGE_MODEL` in `[verifier.env]`. Every
reference solution (`solution/solve.sh`) must score 1: run the dataset with
`oracle` after any task change.

Hill-climb record (2026-11-14), 20 tasks × 3 attempts, each model and variant in its own fresh workspace:
- **The change:** "ask, then stop" in the prompt's authority and automation rules. The prompt describes the action, asks once, and calls no creating tool until the person says yes.
- **Acting before asking** (invite or automation created, 6 trials per model): DeepSeek 4 → 0, GLM 4 → 0.
- **Tasks passed:**
  - DeepSeek V4.1 Flash: 41 → 43/60, mean 0.901 → 0.904.
  - GLM 5.3 Flash: 38 → 46/60, mean 0.881 → 0.942. The baseline had 4 sandboxes fail to start, so it is 38/56 on valid trials.
- **Decision:** kept.
- **Two earlier attempts were void:**
  - the local runner loop still ran the old prompt;
  - the shared workspace kept the connectors and triggers that earlier trials made.
- **Still failing on both models:**
  - `handoff-compare`: My Kortix researches itself instead of handing off.
  - `meeting-actions`: wording.
  - `confirm-before-invite`: it claims an invite cannot grant admin, though `kortix members invite --role admin` works.
  - `automation-asks-first`: its reply misses what the automation needs.

A task that needs a flag says so in `task.toml` `[metadata] requires_flags`.
Judged criteria call `kortix evals judge`, so they need a sandbox image whose
CLI has it.

## Not supported yet

Multi-step tasks, docker-compose environments, a separate verifier
environment, Windows, GPUs, `metric.py`, Harbor's Python agents
(`import_path`). Each is refused with a reason (`TaskUnsupportedError`, a
validation issue), never run wrong.
