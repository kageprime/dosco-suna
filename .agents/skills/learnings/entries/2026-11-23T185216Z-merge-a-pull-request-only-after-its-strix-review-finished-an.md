---
recorded: 2026-11-23T18:52:16Z
incident_date: 2026-11-23
---
# Merge a pull request only after its Strix review finished and lists no finding to fix

**Rule:** Before `gh pr merge`, run `scripts/check-strix-review.sh <pr>`. Merge only on exit 0. Exit 2 means the review has not finished: wait. Exit 1 means it lists findings to fix before merging: fix them on the branch first. A self-merge right after `gh pr create` skips the review.

**Trigger surface:** Self-merging any pull request into `dev`, above all one that parses repository content, user input or network data on the API.

**Incident:** 2026-11-23, PR #13024 (per-agent config release file lists) was squash-merged 17 s after it opened, while Strix still reviewed it. The review then listed 2 HIGH and 1 MEDIUM findings in `agentReleaseFiles`: a backtracking link regex, an unbounded folder fixed point and unbounded blob buffering. Any project member could stall or exhaust a shared API process with one commit. The code was live on dev for about 1 h; prod never had it. Fixed forward in the follow-up PR on the same branch.

**Enforcement:** `scripts/check-strix-review.sh`, run by the **contributing** skill's merge step. No hook blocks `gh pr merge`; the script is the check an agent runs.
