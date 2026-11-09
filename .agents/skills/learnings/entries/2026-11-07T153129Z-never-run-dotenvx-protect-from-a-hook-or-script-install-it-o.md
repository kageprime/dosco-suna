---
recorded: 2026-11-07T15:31:29Z
incident_date: 2026-11-07
---
# Never run dotenvx protect from a hook or script; install it once with the global CLI

**Rule:** No hook or repo script runs `dotenvx protect`. It checks nothing and always exits 0; it writes the global git config (`filter.dotenvx.*`, `required = true`) to run the binary that called it. Gate plaintext `.env` values with a check you own (pre-commit step 1b reads the index), and install `protect` once per machine with the global CLI from outside any checkout.

**Trigger surface:** Editing `.githooks/*`, choosing a dotenvx command for a hook by version, bumping `@dotenvx/dotenvx`.

**Incident:** 2026-11-07, PR #12037. pre-commit picked `dotenvx protect` for dotenvx 2.29+; the repo binary was 1.x, so it never ran until the bump to 2.38.2. The first commit on the bump branch rewrote the author's global filter to that worktree's `node_modules`; with the worktree removed, `git add` of any `.env*` file fails (exit 128) in every repository. Caught before merge; the global filter was restored with the global CLI.

**Enforcement:** `tests/unit/git-hooks-dotenvx.test.ts` fails when a non-comment line of `pre-commit` or `pre-push` names `protect`.
