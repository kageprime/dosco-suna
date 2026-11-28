# Decisions

## 2026-11-23

- **D0 Scope.** One config release per (base commit, agent), holding only the
  files that agent uses in its lifecycle. Never leave out a file the agent
  uses. Paths never move (the lesson of #9197).
- **D1 Agent switch inside a session.** The box converges to the new agent's
  release before the switching turn runs. Rejected: ship the union of the
  agents the session may switch to (close to the full project); fall back to
  the full release on any switch.
- **D2 Publish.** Every base-branch move publishes the release of every
  enabled agent. Rejected: publish only agents with recent sessions and build
  the others on the first request.
- **D3 Sessions without repository access.** They get the same file list,
  including the root `AGENTS.md` and the agent's local `./` pi packages.
