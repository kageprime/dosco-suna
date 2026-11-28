#!/usr/bin/env bash
# Strix review guard: run right before `gh pr merge <pr>`.
#
# Strix posts one security review comment on every pull request, about a
# minute after it opens. On 2026-11-23 #13024 was squash-merged 17 s after it
# opened, while the review still ran. The review then listed 2 HIGH and
# 1 MEDIUM findings ("To fix before merging"), already live on dev.
#
#   scripts/check-strix-review.sh <pr>
#
# Exit 0: the review exists and reports no open finding.
# Exit 1: the review lists findings to fix before merging. Fix them, push,
#         re-run the review from its link, and check again.
# Exit 2: no review yet. Wait and check again.
# A review of an older commit than the PR head passes with a warning.
set -euo pipefail

pr="${1:-}"
if [ -z "$pr" ]; then
  echo "usage: $0 <pr-number>" >&2
  exit 64
fi

repo="${STRIX_CHECK_REPO:-kortix-ai/CompanyOS}"
# Only the Strix app's own comment counts: anyone can post a comment that looks like it.
strix_login="${STRIX_BOT_LOGIN:-strix-security[bot]}"
body="$(gh api "repos/${repo}/issues/${pr}/comments" --paginate \
  --jq "[.[] | select(.user.login == \"${strix_login}\" and .user.type == \"Bot\" and (.body | contains(\"<!-- strix-pr-review\")))] | last | .body // \"\"")"

if [ -z "$body" ]; then
  echo "#${pr}: no Strix review yet. Wait for it, then check again." >&2
  exit 2
fi

# A review in progress keeps the previous verdict on the page under a live status.
if printf '%s' "$body" | grep -qE 'pr-review-live\.gif|strix-pr-review:in-progress'; then
  echo "#${pr}: a Strix review is in progress. Wait, then check again." >&2
  exit 2
fi

if printf '%s' "$body" | grep -q 'To fix before merging'; then
  echo "#${pr}: the Strix review lists findings to fix before merging:" >&2
  printf '%s\n' "$body" | grep -E '^- .*(CRITICAL|HIGH|MEDIUM|LOW)' >&2 || true
  exit 1
fi

if ! printf '%s' "$body" | grep -q 'No open security findings'; then
  echo "#${pr}: the Strix review has not finished. Wait, then check again." >&2
  exit 2
fi

reviewed="$(printf '%s' "$body" | sed -nE 's/.*Review [0-9]+ on this PR · `([0-9a-f]+)`.*/\1/p' | head -1)"
head="$(gh pr view "$pr" --repo "$repo" --json headRefOid --jq .headRefOid)"
if [ -n "$reviewed" ] && [ "${head#"$reviewed"}" = "$head" ]; then
  echo "#${pr}: warning: Strix reviewed ${reviewed}, the head is ${head:0:7}. Re-run the review for a security-relevant push." >&2
fi
echo "#${pr}: Strix review passed."
