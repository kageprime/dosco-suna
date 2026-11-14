# Identity: prove the factory acts on GitHub as itself

Header: `[factory] role=identity mode=<setup|weekly>`. The setup agent starts
one `mode=setup` session after the person stored `FACTORY_GITHUB_TOKEN`
(onboarding step B). The trigger `factory-identity` runs `mode=weekly` every
Monday. The run proves, with the token itself, that the factory is its own
GitHub account, can push a branch, and authors commits that GitHub links to
that account. It never prints the token.

`R` is `repository.full_name`, `T` is the trunk (`gh api repos/$R --jq .default_branch`).
Write scratch files under `/tmp/factory/identity/` only.

## 1. Who the token is

```sh
mkdir -p /tmp/factory/identity
. /workspace/.kortix/software-factory/scripts/github-identity.sh || exit 1
gh api user --jq '{login, id, type, name}'
gh api -i user 2>/dev/null | tr -d '\r' | grep -i '^github-authentication-token-expiration:'   # absent: no expiry
case "$FACTORY_GITHUB_TOKEN" in github_pat_*) echo fine-grained ;; ghp_*) echo classic ;; *) echo other ;; esac
```

- `mode=setup` runs before `identity.github_login` is written, so the script
  checks nothing yet. Report the login: the setup agent compares it with the
  person's own login.
- `type` must be `User`. An `Organization` or a `Bot` token is
  `errors=wrong-account-type`.
- The expiry header gives `expires_in_days` (UTC days, floor). No header:
  `never`.

## 2. What the token may do on the repository

```sh
gh api repos/$R --jq '{private, has_issues, push: .permissions.push}'
gh pr list -R $R --state all --limit 1 --json number >/dev/null && echo pulls=ok
```

`push` must be `true`. `false`: `errors=no-write-access` (the account is not
a collaborator with Write, or the fine-grained token does not include this
repository). `has_issues: false` with `store.kind: github-issues`:
`errors=issues-disabled`.

## 3. Push probe: one branch, one empty commit, then delete it

```sh
d=$(mktemp -d /tmp/factory/identity/probe.XXXXXX) && cd "$d"
git init -q && git remote add origin "https://github.com/$R.git"
. /workspace/.kortix/software-factory/scripts/github-identity.sh || exit 1   # local identity in the probe clone
git fetch -q --depth 1 origin "$T"
git checkout -q -b kortix/identity-check FETCH_HEAD
git commit -q --allow-empty -m "chore: factory identity check"
sha=$(git rev-parse HEAD)
git push -q --force origin HEAD:refs/heads/kortix/identity-check          # the probe branch is the factory's own
gh api repos/$R/commits/$sha --jq '{author: .author.login, committer: .committer.login}'
git push -q origin --delete kortix/identity-check
gh api repos/$R/branches/kortix/identity-check >/dev/null 2>&1 && echo still-there || echo deleted
cd / && rm -rf "$d"
```

- `push_probe=ok`: the push and the delete both succeeded and the branch is
  gone. A refused push names the cause from git's message: `rule` (a branch
  ruleset or protection on `kortix/*`), `auth` (401 or 403), `workflow` (the
  token lacks the Workflows permission and the trunk changed a workflow file
  in the fetched commit), else `other`.
- `author_linked=yes`: GitHub resolved the commit's author and committer to
  the token's login. `no` means the commit email is not one GitHub knows for
  the account: set `identity.email` to `<id>+<login>@users.noreply.github.com`.
- The delete failed: say so in the run line (`probe_branch=left`). Never leave
  it silently.

## 4. Act on the result

- `mode=setup`: write nothing to the store. The run line is the result.
- `mode=weekly`, everything ok and `expires_in_days` > 14 or `never`: write
  nothing.
- `mode=weekly`, a failure the token can still report (no write access,
  push refused, author not linked) or `expires_in_days` ≤ 14: upsert one
  ticket with the key `factory-identity:token` (contract §5), kind `task`,
  priority 1 on a failure and 2 on an expiry, state `blocked`, label
  `source:factory-identity`. `## What`: the failure or the expiry date.
  `## Proposed change`: what the person does:
  1. Sign in to GitHub as `identity.github_login` and open
     `https://github.com/settings/personal-access-tokens/new?name=Kortix%20factory&description=Software%20Factory%20for%20<R>&target_name=<owner>&expires_in=366&contents=write&pull_requests=write&issues=write&metadata=read&workflows=write&actions=read&checks=read&statuses=read`
     (a classic token for a personal-account repository: onboarding step B).
  2. Run `kortix secrets request FACTORY_GITHUB_TOKEN --scope runtime` and
     paste the new token in the link.
  3. Fire `kortix triggers fire factory-identity` to close this ticket.
  A later run that finds everything ok closes it: `[factory-source] resolved`
  and `set_state(done)`.
- The token is rejected (`errors=token-rejected`): no store write is
  possible. The run fails with that line; `kortix triggers runs
  factory-identity` and `kortix templates doctor software-factory` show it.

## Run line

```
factory-identity: login=<login> id=<id> name=<name> email=<email> token=<fine-grained|classic|other> expires_in_days=<n|never> repo_push=<yes|no> push_probe=<ok|failed:rule|failed:auth|failed:workflow|failed:other> author_linked=<yes|no> probe_branch=<deleted|left> errors=<none|codes>
```

Never print the token, a header that holds it, or a remote URL with
credentials in it.
