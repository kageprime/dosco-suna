---
recorded: 2026-11-11T18:56:05Z
incident_date: 2026-11-11
---
# Give every version-floored CI tool install a bounded try per source, a fallback that needs no third host, and a failing check below the floor

**Rule:** When a CI step installs a tool the tests need at a minimum version
(git 2.45+ for partial stores), give each attempt at the mirror a hard
`timeout`, fall back to a source the runners already reach (GitHub, the
Ubuntu archive), and end the step with a version check that fails it.
Never let the step finish on the distro version: the lane then runs for
minutes and reports test failures that hide the cause. Build a fallback
with every feature the tests use (`USE_LIBPCRE` for `git grep -P`).

**Trigger surface:** editing an install step in `.github/workflows/*.yml`,
or reading a lane failure that names a tool version ("need git 2.45").

**Incident:** 2026-11-11, v0.15.7 release suite. `api.launchpad.net` timed
out from the `vulcan` runners, `add-apt-repository ppa:git-core/ppa` failed 3
times per lane (~7.5 min), and every lane ran on git 2.43: 11 config-summary
DB tests went red. The first source-build fallback (PR #12447) lacked PCRE
and broke `docker-rm-removes-volumes.test.ts` (fixed in PR #12455). Two extra
suite cycles, ~2.5 h.

**Enforcement:** the `Install git 2.45 or later` step in `tests.yml` ends
with `git_ok || { echo "::error::…"; exit 1; }`: a lane below 2.45 fails
at setup with that line. The fallback was proven in `ubuntu:24.04` with the
Launchpad hosts blocked (git 2.47.3 in 64 s, `git grep -P` matches).
