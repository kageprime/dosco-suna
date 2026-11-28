---
recorded: 2026-11-26T22:07:18Z
incident_date: 2026-11-26
---
# Never reset an agent test project while a test run is open: wait for the run to finish, and treat any error from the harness CLI as not finished

**Rule:** Reset the QualiLoop test project only after every run of the launch has finished. `qualiloop runs wait` exit `0` or `1` means finished; any other exit (`3` signed out, `5` wait timeout, `6` network) means it may still be running.

**Trigger surface:** Scripting or running `reset.sh` around QualiLoop suites, or any cleanup of a project an external harness is talking to.

**Incident:** 2026-11-26 19:37 UTC, dev, the Workspace configuration batch (78 runs). The QualiLoop CLI sign-in had expired. The runner script took the CLI's error as "batch finished" and ran `reset.sh`. It deleted the sessions of 17 conversations still in flight. They ended with empty replies or "no activity for 30 minutes", and their results were unusable. They were re-run the same night.

**Enforcement:** `reset.sh` refuses while QualiLoop lists an open run, and when the QualiLoop CLI cannot answer (#13164). `QUALILOOP_RESET_FORCE=1` skips the check; use it only when no run is open.
