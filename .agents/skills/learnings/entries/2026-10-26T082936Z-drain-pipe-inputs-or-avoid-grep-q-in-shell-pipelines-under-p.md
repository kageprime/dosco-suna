---
recorded: 2026-10-26T08:29:36Z
incident_date: 2026-10-26
---
# Drain pipe inputs or avoid grep -q in shell pipelines under pipefail

**Rule:** Never use early-terminating readers (`grep -q`, `head -n N`) in shell pipelines where `set -o pipefail` is active; drain the pipe completely (`grep -vE ... >/dev/null`) or disable `pipefail` for the test. An early exit closes stdin, causing the upstream writer (`printf`, `cat`, `git diff`) to fail with SIGPIPE (exit status 141), which `pipefail` propagates as a command failure.

**Trigger surface:** Shell scripts using `set -uo pipefail` that pipe multi-megabyte streams or long diffs into `grep -q`.

**Incident:** 2026-10-26, Vercel production frontend deploy for commit `a5d2b41bbb`. `apps/web/scripts/vercel-ignore.sh` executed `printf '%s\n' "$changed" | grep -qvE "$SAFE"` on a 1.1 MB diff (6,836 file paths). `grep -q` found a non-matching line early and exited with 0, closing stdin. `printf` received SIGPIPE (exit status 141) while writing the remaining lines. Under `set -uo pipefail`, the pipeline exited with 141. The conditional `if ! ...; then` inverted this non-zero exit status to true, falsely concluding that only safe non-FE paths changed and exiting with 0. This silently canceled the production Vercel frontend build.

**Enforcement:** Replaced `grep -qvE "$SAFE"` with `grep -vE "$SAFE" >/dev/null` in `apps/web/scripts/vercel-ignore.sh`. The writer drains completely to `/dev/null` without SIGPIPE, returning clean exit code 0 on matches and 1 on non-matches.
