---
name: kortix-program-agents
description: "Write a program agent: an agent in kortix.yaml with `run: <command>` that runs code for each turn instead of a model. Load when someone asks for an agent, a trigger or an automation that runs a script, a TS/JS/Python file, `@kortix/sdk` code or any fixed sequence of steps with no judgment, or when you edit an agent block that has `run`."
metadata:
  kortix-feature-flag: program_agents
---

<skill name="kortix-program-agents">

<overview>
A program agent is an agent whose turn runs a command instead of a model.
It keeps everything an agent has: its identity and grants, its computer
(`workspace`), its secrets, and every way to start it (triggers, chat,
Spaces, the `agent` tool of another agent).

Choose it for fixed steps: a sync, a report, a cleanup, a webhook handler.
Choose a model agent for judgment: reading, deciding, writing for people.
A program agent runs to completion. For a watch that never stops, build an App
that sends App events, and give a trigger on those events to the program agent.
</overview>

<shape>
```yaml
agents:
  janitor:
    description: Closes pull requests idle for 30 days.
    run: pnpm tsx agents/janitor.ts
    timeout: 10m
    secrets: [GITHUB_TOKEN]
    kortix_permissions: [workspace.gitops.read]
    workspace:
      repos: [{ path: /workspace }]
      setup: [pnpm install --frozen-lockfile]

triggers:
  - slug: janitor-hourly
    on: { every: 1h }
    run: { agent: janitor, session: reuse, payload: { days: 30 } }
  - slug: janitor-hook
    on: { webhook: { secret: JANITOR_HOOK } }
    run: { agent: janitor }
```

- `run` is one shell command (1 to 4096 characters). Put the logic in a file in the repository.
- `run` excludes `model`, `prompt` and `prompt_file`: validation fails with them.
- Model keys (`variant`, `temperature`, `codemode`, `skills`, …) have no effect: validation warns.
- `workspace.repos` clones the repository (needs `workspace.gitops.read`); `workspace.setup` installs dependencies. The command waits for both.
- `timeout`: the run limit, `1s` to `6h`, default `30m`.
- A trigger of a program agent omits `prompt`: its input is then the whole payload as JSON. `run.payload` adds fixed parameters to it.
- `session: reuse` on a frequent trigger: one session whose computer resumes with dependencies installed. The default `fresh` starts a new computer and runs `workspace.setup` on every fire.
</shape>

<contract>
One turn = one run of the command, in the first `workspace.repos` path (else `/workspace`):

| | |
| --- | --- |
| Input | The turn's message on stdin. `$KORTIX_EVENT_PATH` names a JSON file: `{ version, session_id, agent, prompt }`. |
| Trigger input | A trigger with no `prompt`: stdin is the whole payload as JSON, exactly (no other text): `trigger` (`slug`, `type`), `fired_at`, then `body` and `headers` for a webhook, `event` for an event or App event, `change_request` for a merge, `source`, `actor`, `message` for a manual fire. The trigger's `run.payload` keys are merged in; the fire's own keys win. A `prompt` template instead sends its rendered text. |
| Time limit | `timeout` (default `30m`, at most `6h`). Past it: SIGTERM, SIGKILL 5 s later, and the turn fails with "ran longer than its timeout". |
| Reply | stdout, rendered as Markdown. The first 256 KiB are kept. |
| Failure | A non-zero exit fails the turn; the error shows the last 4 KiB of stderr. A failed run is never retried. |
| Stop | SIGTERM to the command's process group, SIGKILL 5 s later. |
| Environment | The agent shell's: its granted secrets, `KORTIX_TOKEN`, `KORTIX_API_URL`, `KORTIX_PROJECT_ID`, `KORTIX_SESSION_ID`, `KORTIX_AGENT_NAME`. |
</contract>

<sdk>
The computer holds the agent's own `KORTIX_API_URL` and `KORTIX_TOKEN`. Pass them to `createKortix`, so every call acts as the agent:

```ts
import { readFileSync } from 'node:fs'
import { createKortix } from '@kortix/sdk'

const event = JSON.parse(readFileSync(process.env.KORTIX_EVENT_PATH!, 'utf8'))
const input = JSON.parse(event.prompt) // a trigger with no prompt: the payload as JSON
const kortix = createKortix({ backendUrl: process.env.KORTIX_API_URL!, getToken: async () => process.env.KORTIX_TOKEN! })
const sessions = await kortix.project(process.env.KORTIX_PROJECT_ID!).sessions.list()
console.log(`Checked ${sessions.length} sessions for ${input.trigger.slug} (last ${input.days} days).`)
```

Add `@kortix/sdk` to the repository's `package.json` and install it in `workspace.setup`. SDK releases after 0.15.10 also accept `createKortix()` with no options and read the same two variables.
</sdk>

<setup-pitfalls>
- Every agent that clones the repository shares its one `package.json`. Keep the dependencies compatible: `@kortix/sdk` needs `zod` `^3.25.0` or `^4`.
- pnpm 10+ refuses dependency build scripts and exits 1 (`ERR_PNPM_IGNORED_BUILDS`, for example `esbuild` under `tsx`). Allow them in `pnpm-workspace.yaml`: `allowBuilds: { esbuild: true }`. pnpm no longer reads the `pnpm` field of `package.json`.
- A failed setup step fails every turn with "The workspace setup failed at `<step>`" and the program does not run. The log is `/tmp/kortix/workspace-setup.log` in the session's computer.
- A webhook trigger's secret must have connector scope: `kortix secrets set <NAME>=<value> --scope connector`. A runtime-scope secret answers `401` to every delivery.
</setup-pitfalls>

<checks>
1. `kortix validate`: no error on the agent.
2. Run the command once by hand in a session with a sample input: `echo '<input>' | KORTIX_EVENT_PATH=/tmp/e.json <command>`.
3. Fire the trigger (`kortix triggers fire <slug>`) and read the run's outcome.
</checks>

<off>
The `program_agents` feature must be on for the workspace. With it off, a turn of a program agent fails with "Program agents are off for this workspace" and nothing runs.
</off>

</skill>
