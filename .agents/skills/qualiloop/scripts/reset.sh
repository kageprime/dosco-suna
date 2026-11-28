#!/usr/bin/env bash
# Puts the QualiLoop test project back to its baseline, so every suite run starts from the
# same workspace. Test conversations make real things: agents, skills, crons, reminders, Apps,
# connectors, secrets, Drive files, memory, artifacts and invites. Left behind, they fire, spend, and change what
# the next test sees.
#
#   KORTIX_TOKEN=<test user's access token> QUALILOOP_KORTIX_PROJECT_ID=<id> reset.sh
#
# KORTIX_API defaults to dev. Refuses while a QualiLoop run is open (QUALILOOP_RESET_FORCE=1 skips
# that check). Exits 1 when anything is left over.
set -euo pipefail
A="${KORTIX_API:-https://dev-api.kortix.com/v1}"
P="${QUALILOOP_KORTIX_PROJECT_ID:?}"
: "${KORTIX_TOKEN:?}"
BASELINE_TAG=qualiloop-baseline

api() { # api METHOD PATH [BODY] -> body; fails on a non-2xx status
  local out code
  out=$(curl -sS -X "$1" "$A$2" -H "Authorization: Bearer $KORTIX_TOKEN" -H 'content-type: application/json' \
    ${3:+-d "$3"} -w '\n%{http_code}')
  code=${out##*$'\n'}
  out=${out%$'\n'*}
  [[ $code == 2* ]] || { echo "$1 $2 -> $code ${out:0:200}" >&2; return 1; }
  printf '%s' "$out"
}
uri() { jq -rn --arg v "$1" '$v|@uri'; }
step() { printf '%-22s' "$1"; }

# A reset during a run deletes the sessions of the conversations still talking to the agent.
# QualiLoop says whether one is open; when it cannot say (signed out, offline), nothing is reset.
if [ "${QUALILOOP_RESET_FORCE:-}" != 1 ]; then
  open=$(npx -y qualiloop@0.2.0 --json runs list --limit 200 2>/dev/null | jq '[(.runs // .)[] | select(.finished == false)] | length') \
    || { echo "QualiLoop did not answer: sign in (npx qualiloop login), or set QUALILOOP_RESET_FORCE=1" >&2; exit 1; }
  [ "$open" = 0 ] || { echo "$open QualiLoop runs are still open: reset after they finish" >&2; exit 1; }
fi

# Nothing fires while the project is half reset.
api PATCH "/projects/$P/triggers/activation" '{"paused":true}' >/dev/null

step "runtime triggers"
ids=$(api GET "/projects/$P/triggers/all" | jq -r '.triggers[] | select(.origin == "runtime") | .id')
for id in $ids; do api DELETE "/projects/$P/triggers/runtime/$(uri "$id")" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

step "apps"
ids=$(api GET "/projects/$P/apps" | jq -r '.apps[] | (.id // .app_id)')
for id in $ids; do api DELETE "/projects/$P/apps/$id" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

step "connectors"
ids=$(api GET "/connectors/projects/$P/connectors" | jq -r '(.connectors // .)[] | .slug')
for id in $ids; do api DELETE "/connectors/projects/$P/connectors/$(uri "$id")" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

step "secrets"
ids=$(api GET "/projects/$P/secrets" | jq -r '.items[] | .name')
for id in $ids; do api DELETE "/projects/$P/secrets/$(uri "$id")" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

# Drive: the project's files and the test user's own folder (My Kortix memory lives in it).
step "drive files"
drive=$(api GET "/drives?projectId=$P" | jq -r '.drives[] | select(.kind == "project")')
D=$(jq -r .driveId <<<"$drive")
home=$(jq -r .personalFolder <<<"$drive")
paths=$( { api GET "/drives/$D/files?path=/" | jq -r '.entries[] | select(.path != "/Users") | .path'
           api GET "/drives/$D/files?path=$(uri "$home")" | jq -r '.entries[] | .path'; } )
while IFS= read -r f; do
  [ -n "$f" ] && api DELETE "/drives/$D/files?path=$(uri "$f")&recursive=true" >/dev/null
done <<<"$paths"
echo "$(grep -c . <<<"$paths" || true) deleted"

step "artifacts"
ids=$(api GET "/projects/$P/artifacts" | jq -r '.artifacts[] | (.artifact_id // .id)')
for id in $ids; do api DELETE "/projects/$P/artifacts/$id" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

# Invites a test sent (the test account is the workspace's only member).
step "invites"
W=$(jq -r .accountId <<<"$drive")
ids=$(api GET "/accounts/$W/invites" | jq -r '.[] | (.invite_id // .id)')
for id in $ids; do api DELETE "/accounts/$W/invites/$id" >/dev/null; done
echo "$(wc -w <<<"$ids" | tr -d ' ') deleted"

# The repository: agents, skills, declared triggers and connectors live in kortix.yaml and its
# tree. A new commit with the baseline tree, so the history stays.
step "repository"
git_json=$(api POST "/projects/$P/git-token")
repo=$(jq -r .repo_url <<<"$git_json")
auth_url="https://$(jq -r .git_username <<<"$git_json"):$(jq -r .push_token <<<"$git_json")@${repo#https://}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git clone -q "$auth_url" "$work/repo" 2>/dev/null
(
  cd "$work/repo"
  # The tag marks the tree the project had when it was created (set once, see SKILL.md).
  base=$(git rev-parse -q --verify "refs/tags/$BASELINE_TAG^{commit}") || { echo "no tag $BASELINE_TAG" >&2; exit 1; }
  if git diff --quiet "$base" HEAD; then echo "already at $BASELINE_TAG"; exit 0; fi
  git rm -rqf . && git checkout "$base" -- .
  git -c user.name=qualiloop-reset -c user.email=qualiloop-reset@kortix.invalid \
    commit -q -m "QualiLoop reset: back to $BASELINE_TAG"
  git push -q origin HEAD 2>/dev/null
  echo "reset to $BASELINE_TAG ($(git rev-parse --short "$base"))"
)

# Sessions last: one may still have been writing to the Drive or the repository above.
step "sessions"
n=0
for _ in $(seq 20); do # pages of 200
  ids=$(api GET "/projects/$P/sessions?limit=200" | jq -r '.[] | (.session_id // .id)')
  [ -z "$ids" ] && break
  for id in $ids; do api DELETE "/projects/$P/sessions/$id" >/dev/null; n=$((n + 1)); done
done
echo "$n deleted"

api PATCH "/projects/$P/triggers/activation" '{"paused":false}' >/dev/null

# Proof: every list is empty again. The repository's declared triggers leave once the push syncs.
left=0
for _ in 1 2 3 4 5 6; do
  t=$(api GET "/projects/$P/triggers/all" | jq '.triggers | length')
  [ "$t" = 0 ] && break
  sleep 5
done
check() { local n; n=$(eval "$2"); echo "left: $1 = $n"; [ "$n" = 0 ] || left=1; }
check triggers "echo $t"
check apps "api GET /projects/$P/apps | jq '.apps | length'"
check connectors "api GET /connectors/projects/$P/connectors | jq '(.connectors // .) | length'"
check secrets "api GET /projects/$P/secrets | jq '.items | length'"
check sessions "api GET '/projects/$P/sessions?limit=200' | jq length"
check artifacts "api GET /projects/$P/artifacts | jq '.artifacts | length'"
check invites "api GET /accounts/$W/invites | jq length"
check "home files" "api GET '/drives/$D/files?path=$(uri "$home")' | jq '.entries | length'"
exit $left
