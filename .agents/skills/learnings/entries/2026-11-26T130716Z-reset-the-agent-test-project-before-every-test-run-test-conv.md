---
recorded: 2026-11-26T13:07:16Z
incident_date: 2026-11-26
---
# Reset the agent test project before every test run: test conversations create real crons, Apps and invites that keep running

**Rule:** Before an external harness (QualiLoop) runs a suite against a real agent, reset the project it runs in with `.agents/skills/qualiloop/scripts/reset.sh`, and reset it again after the run. Treat every test conversation as a person who really configured the workspace.

**Trigger surface:** Running, re-running or generating agent tests whose conversations end in real tool calls: agents, skills, schedules, reminders, Apps, connectors, secrets, Drive files, memory, invites.

**Incident:** 2026-11-26, the dev QualiLoop test project after about 140 test conversations (Core runs 1 and 2, then 9 reruns). The project held 80 triggers: 3 declared crons, one of them every 5 min against an App a test had built, and 77 runtime reminders. It also held 6 Apps, 10 connectors, a secret, Drive files and memory, 2 artifacts and 1 invite (to an `example.com` address). Crons fired overnight with nobody testing. Every later test met that workspace, not a fresh one, so results depended on test order. The same tests on the same model gave 19 major problems, then 7. Fixed in #13113: `reset.sh` deletes all of it, resets the repository to the tag `qualiloop-baseline`, and exits `1` when a list is not empty.

**Enforcement:** `reset.sh` exits `1` when anything is left. Nothing runs it automatically yet: the enforcer to build is a QualiLoop pre-run hook, or a check in the endpoint that refuses the first turn of a run while the project holds test-made state.
