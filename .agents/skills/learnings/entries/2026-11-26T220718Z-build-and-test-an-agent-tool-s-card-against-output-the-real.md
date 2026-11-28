---
recorded: 2026-11-26T22:07:18Z
incident_date: 2026-11-26
---
# Build and test an agent tool's card against output the real CLI printed, never against the shape you expect it to print

**Rule:** When a tool parses a CLI's `--json` output to build what the model reads, write its test fixture from output the real CLI printed (or from the CLI's own output type), and check the card against the data it came from. A card that says "0" while `data` holds rows is a bug.

**Trigger surface:** Writing or changing a My Kortix platform tool (`apps/kortix-sandbox-agent-server/src/services/tools/platform/*.ts`), or the `--json` output of a `kortix` command a tool reads.

**Incident:** Found 2026-11-26 from QualiLoop traces on dev; the bugs had shipped to prod. `kortix_connectors list` read `profiles` while the CLI prints `connectors`, so every card said "0 connectors" (59 of 59 calls). `kortix_people pending` read `invites` while the CLI prints `pending`, so it said "0 open invitations" and My Kortix re-sent invitations. A static audit of all 41 CLI calls found 8 more (find badged every app "added", sessions read `runtime_status` values that never occur, usage passed USD, …). Separately, `kortix agents scope --show` printed `secrets: all` for agents that the runtime grants `none`. In the 229 tested conversations, the 93 that met a wrong card averaged 1.22 major problems against 0.65 for the rest. Fixed in #13164.

**Enforcement:** `apps/kortix-sandbox-agent-server/src/__tests__/platform-tools.test.ts` "CLI output shapes" uses shapes the real CLI printed on dev. None yet for new tools: the enforcer to build is a typed contract (the tool imports the CLI command's output type) so a renamed key fails typecheck.
