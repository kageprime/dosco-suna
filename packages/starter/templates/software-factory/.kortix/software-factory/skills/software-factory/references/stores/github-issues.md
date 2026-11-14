# Store: GitHub Issues

`store.kind: github-issues`, `store.target: <owner>/<repo>` (the code
repository, or a separate tracker repository). Tool: `gh`, authenticated as
the factory by `scripts/github-identity.sh` (contract §0.1). Every call names
the repository: `R=<store.target>`.

## Conventions

- **States are labels** `factory:triage`, `factory:ready`, `factory:in-progress`,
  `factory:in-review`, `factory:blocked`. A ticket carries exactly one.
  `done` is a closed issue with reason `completed`; `canceled` is a closed issue
  with reason `not planned`.
- **The agent identity** is `identity.github_login` (contract §0.1), the
  login of `FACTORY_GITHUB_TOKEN`. A machine user keeps every factory comment,
  label change and pull request apart from the people's.
- **Assignment** is the label, not the assignee: `assign(agent)` adds
  `factory:` state labels only. `assign(creator)` and `assign(none)` change
  nothing. GitHub assignees stay with the people.
- **Accept label** `labels.accept` (default `kortix`): a person adds it to
  hand an issue to the factory. Only users with triage access can add a label
  to an issue, so a stranger cannot start the factory on a public repository.
- **Priority** is a label `priority:1` … `priority:4`.
- **Links**: a pull request body with `Closes #<n>` links itself; a session
  link is a comment line.
- A pull request is also an issue in the GitHub API: every `list` adds
  `is:issue`.

## Operations

| Operation | Command |
|---|---|
| `store.context` | `gh api user --jq .login` (must equal `identity.github_login`); `gh api repos/$R --jq '{private,has_issues}'`. `has_issues` false: stop, `errors=issues-disabled` |
| `label.ensure(name)` | `gh label create "<name>" -R $R --color 0E8A16 --description "Software Factory" 2>/dev/null \|\| true` |
| `ticket.find_by_key(key)` | `gh search issues --repo $R --match body "\"factory-key: <key>\"" --json number,state,body,closedAt,stateReason --limit 20`, then keep the issues whose last non-empty body line equals `factory-key: <key>`. The search index lags up to about a minute: in the same run, also check the run map (§5 of the contract) |
| `ticket.list(filter)` | `gh issue list -R $R --label factory --state open --limit 500 --json number,title,labels,updatedAt,createdAt,author,body > /tmp/factory/<role>/issues.json`, plus `--label kortix` for the hand-overs; reduce with `jq` |
| `ticket.get(id)` | `gh issue view <n> -R $R --json number,title,body,state,stateReason,labels,author,url,closedAt` |
| `ticket.comments(id)` | `gh api repos/$R/issues/<n>/comments --paginate --jq '.[] \| {id, user: .user.login, type: .user.type, created_at, body}'` |
| `ticket.create(fields)` | `gh issue create -R $R --title "<title>" --body-file <file> --label factory --label source:<s> --label kind:<k> --label priority:<p> --label factory:triage`; read the number from the printed URL |
| `ticket.update(id, fields)` | `gh issue edit <n> -R $R --title … --body-file … --add-label … --remove-label …` |
| `ticket.comment(id, body)` | `gh issue comment <n> -R $R --body-file <file>` |
| `ticket.set_state(id, s)` | open states: `gh issue edit <n> -R $R --add-label factory:<s> --remove-label <every other factory: state label>` (reopen first when closed). `done`: `gh issue close <n> -R $R --reason completed`. `canceled`: `gh issue close <n> -R $R --reason "not planned"` |
| `ticket.assign(id, who)` | no assignee change (conventions) |
| `ticket.claim(id, session)` | `set_state(in-progress)`, then the `[factory-intake] claimed` comment |
| `ticket.link(id, url, title)` | one comment `<title>: <url>` (skip it for a pull request whose body says `Closes #<n>`) |
| `ticket.reopen(id)` | `gh issue reopen <n> -R $R`, then `set_state(triage)` |
| `ticket.cancel(id, marker)` | the marker comment, then `gh issue close <n> -R $R --reason "not planned"` |

## Who the factory works on

An open issue is factory work when it carries `factory` and a `factory-key:`
last line (the factory filed it), or `kortix` (a person added it). Read the
label event to prove a person added `kortix`:
`gh api repos/$R/issues/<n>/events --jq '[.[] | select(.event=="labeled" and .label.name=="kortix")] | last | .actor | {login, type}'`
must be `User`. With `identity.kind: machine-user` its `.actor.login` must
also differ from `identity.github_login` (a machine user is of type `User`
too). With `identity.kind: personal` the person and the factory share one
login: a `User` actor is enough.

## Limits

- Search: 30 requests per minute. A run that looks up more than 20 keys reads
  `ticket.list` once and matches keys in code instead.
- REST: 5,000 requests per hour per token. A `403` with
  `x-ratelimit-remaining: 0` is a rate limit (contract hard rule 21).
- Public repository: every ticket is public. The no-customer-data rule is
  strict here. Security findings never go into a public issue: file them as a
  draft repository security advisory
  (`gh api repos/$R/security-advisories -f summary=… -f description=… -f severity=…`)
  and a private `factory` ticket in `json-file` form, or require a private
  `store.target` (`references/sources/security.md`).
