# Source: tests (nightly end-to-end)

Trigger `source-tests` (cron, 03:00 UTC). Enabled by default.

| | |
|---|---|
| Signal | the repository's end-to-end (or full) test suite on the trunk, once a night |
| Finding | one test that fails on the trunk and fails again on a rerun (not a flake) |
| Bar | the failure reproduces `1 + sources.tests.flaky_reruns` times in a row on a clean checkout of the trunk. A failure of the environment (a missing secret, a port in use, a download error) is not a finding: fix the dev environment notes or name it in `errors=` |
| Key | `tests:<suite>:<test-id-slug>` (the suite name and the test's full name, slugged) |
| Signal value | `signal: failing_runs=<n> since=<first failing date>` |
| Priority | 2 when the test covers sign-in, payment or data writes; else 3 |
| Kind | `bug` (or `test` when the test itself is wrong, proven by reading it) |
| Credentials | `FACTORY_GITHUB_TOKEN`; the secrets the `dev-environment` skill names; never production credentials |

## Run

1. Clone the trunk: `gh repo clone <repo> ~/work/repo -- --depth 50`, or fetch
   and reset an existing clone to `origin/<trunk>`.
2. Load the `dev-environment` skill. The command is `sources.tests.command`,
   else the end-to-end command the skill names, else the repository's `test:e2e`
   or `e2e` script. None: end with `errors=no-e2e-command` and post nothing.
3. Install, start the services, run the suite in the background with a log and
   an exit file: `(cmd > /tmp/factory/tests/run.log 2>&1; echo $? > /tmp/factory/tests/exit) &`.
   Poll it. Parse the runner's report (JUnit XML, JSON reporter, or the summary
   lines) into `{suite, test, error class, file:line}` rows. Never paste the
   whole log into the conversation.
4. Rerun each failing test alone, `flaky_reruns` times. Passes on a rerun: a
   flake. Collect flakes in one digest comment on the `tests:ledger` ticket, not
   a ticket each. A test that flaked on 3 nights of 7 is a finding (`kind:test`,
   key `tests:<suite>:<slug>:flaky`).
5. Upsert one ticket per finding (contract §5): `## Evidence` holds the test
   name, the assertion and its expected and actual values, the file and line,
   the trunk commit (`git rev-parse --short HEAD`), and the first failing night
   (`git log` of the test file, or the ledger). `## Proposed change` names the
   suspect commit when `git log --since=<last green night>` touches the code
   under test. `## Acceptance`: `<the test command> passes`, plus a regression
   test when the bug is in product code.
6. A ticket whose test now passes: `[factory-source] resolved · passes at <sha7>`
   and `set_state(done)`, only when the ticket has no open pull request (a
   worker owns it otherwise).
7. Update the `tests:ledger` ticket: one comment
   `[factory-source] update · run <date> · <n> pass · <n> fail · <n> flaky · <sha7>`.
8. End with `source-tests:` and the contract run line.
