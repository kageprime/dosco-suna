# {{projectName}}

A Dosco workspace. Talk to **Xera** in the Dosco app. It routes each task
to the right agent of this workspace and runs it with your permissions.

This workspace starts with one agent, **Worker** (`agents.worker` in
`kortix.yaml`, prompt in `agents/worker.md`). It does general-purpose work:
coding, research, writing, ops and data work. Add specialist agents next to
it; Xera routes each task to the agent that fits.

| Path | What it holds |
| --- | --- |
| `kortix.yaml` | The workspace: its agents and what each may use, triggers, sandbox. |
| `agents/<name>.md` | One agent's instructions. `kortix.yaml` points at it with `prompt_file`. |
| `skills/<name>/SKILL.md` | Skills an agent loads when a task matches. |
| `memory/` | The workspace's memory. Agents read and add to it. |

Add an agent, a skill or a trigger by asking Xera, in **Workspace settings**, or by
editing `kortix.yaml`. Check the file with `kortix validate`.
