## Software Factory: the steps of this template

Run the guide below as written. This template adds its steps at the points
named here, in this order: **analysis → identity → store → sources → first
proof**. The factory is one agent, `factory`, with one contract skill,
`software-factory`. Its files are under `.kortix/software-factory/`: read
`skills/software-factory/SKILL.md` once before you start (sections 0, 0.1
and 1 at least), so you know the identity, the store, the sources and the
merge policy you set up.

Every **Ask** below is a question for the one message of guide step 3, with
its recommended answer. Never ask it where it appears.

### A. In guide steps 2 to 4: analysis, then factory.json

1. Run every check of
   `.kortix/software-factory/skills/software-factory/references/analysis.md` on
   the checkout. Read only; never `cat` an env file.
2. **Ask** which ticket store is the source of truth (analysis section 2).
   Recommend the one the team uses; none: GitHub Issues on this repository.
3. **Ask** which sources to turn on. Show only the sources whose evidence you
   found (analysis section 3), one line each: the evidence, what it needs.
   For example: `@sentry/nextjs` in `package.json` → `errors` (Sentry, poll),
   needs `SENTRY_AUTH_TOKEN` and `SENTRY_ORG`. Default: `github-issues` and
   `tests`. Security: **Ask** for the targets; the default is the app in its
   own sandbox only.
4. **Ask**: "May the factory merge pull requests that pass every gate, or does
   a person merge each one?" Default and recommended to start: a person merges
   (`merge.policy: hold`).
5. Write `.kortix/software-factory/factory.json` (analysis section 6). Turn
   each chosen source's trigger on and every other source's trigger off in
   `factory.yaml` (`enabled: true` or `false`), so the two files agree. The
   `errors` source has two triggers: enable `source-errors-poll` for
   `delivery: poll`, `source-errors` for `push`.

### A.5 Repository rules that conflict with the factory

Read the code repository's `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md`. A rule
that conflicts with the factory contract (for example "push to main") is shown to
the person with the factory's rule beside it. **Ask** which one wins; the factory's
contract wins without an answer. Write the decision into the `dev-environment`
skill. When the config lives in its own repository, the code repository's skills
(`.agents/skills`, `.claude/skills`) cannot be registered from it: the worker reads
them from its clone, and the `dev-environment` skill names where they are.

### B. In guide step 4: grant the dev environment

Add `dev-environment` to `agents.factory.skills` in
`.kortix/software-factory/factory.yaml`, once `kortix.yaml` registers it. The
workers verify every change with its commands.

### C. After guide step 6: the factory's own GitHub identity

The factory needs `FACTORY_GITHUB_TOKEN`, not `GH_TOKEN`. Do this instead of
a generic GitHub token secret. `<owner>/<repo>` is the code repository.

1. **Ask**: "Should the factory act as its own GitHub account (a machine
   user, recommended) or as you?" A machine user keeps every factory issue,
   comment, commit and pull request apart from the people's, and a person can
   approve its pull requests. Write the answer to `identity.kind`
   (`machine-user` or `personal`).
2. **Machine user.** Reuse an existing bot account, or the person creates one
   at `https://github.com/signup` in a private window, with a mailbox they
   control (for example `github-bot@<their domain>`) and a name such as
   `<owner>-kortix-bot`, and turns on two-factor authentication. Then, with
   the person's own `gh`:
   - **Organization repository** (an organization owner runs it): invite the
     bot to the organization and give it Write on the repository:
     `gh api orgs/<owner>/invitations -F invitee_id=$(gh api users/<bot> --jq .id) -f role=direct_member`,
     then `gh api repos/<owner>/<repo>/collaborators/<bot> -X PUT -f permission=push`.
     A fine-grained token reaches an organization's repository only when its
     account is a member. On a paid plan the bot takes one seat.
   - **Personal-account repository**:
     `gh api repos/<owner>/<repo>/collaborators/<bot> -X PUT -f permission=push`.

   The person signs in as the bot and accepts the invitations
   (`https://github.com/orgs/<owner>/invitation`,
   `https://github.com/<owner>/<repo>/invitations`).
3. **The token**, minted while signed in as the token's account:
   - Organization repository, or the person's own account: a fine-grained
     token, pre-filled:
     `https://github.com/settings/personal-access-tokens/new?name=Kortix%20factory&description=Software%20Factory%20for%20<owner>%2F<repo>&target_name=<owner>&expires_in=366&contents=write&pull_requests=write&issues=write&metadata=read&workflows=write&actions=read&checks=read&statuses=read`.
     The person selects **Only select repositories** → `<owner>/<repo>`, and
     generates it. When the organization requires approval of fine-grained
     tokens, an owner approves it at
     `https://github.com/organizations/<owner>/settings/personal-access-token-requests`.
   - Machine user on a personal-account repository: GitHub's fine-grained
     tokens cannot reach another user's repository, so mint a classic token:
     `https://github.com/settings/tokens/new?description=Kortix%20factory%20<owner>%2F<repo>&scopes=repo,workflow`
     with an expiration of one year. It reaches only the repositories the bot
     can access: this one.
   - **Own account (fallback)**: the fine-grained URL above, signed in as the
     person. Say why it is the fallback: every factory action shows as the
     person; GitHub refuses the person's approval of the factory's pull
     requests (an author cannot approve their own pull request), so another
     person approves them; and only the markers tell the person's comments
     from the factory's.
4. Run `kortix secrets request FACTORY_GITHUB_TOKEN --scope runtime` and give
   the person the link. They paste the token there. Never ask for it in the
   chat and never read it.
5. **Identity check**, run by the factory with the token itself:

   ```sh
   sid=$(kortix sessions new --agent factory --label factory-identity --prompt "[factory] role=identity mode=setup" --json | jq -r .session_id)
   kortix sessions wait-for "$sid"
   kortix sessions log "$sid"     # the line that starts with factory-identity:
   ```

   Expected: `login=` the bot (for a machine user it differs from the
   person's `gh api user --jq .login`), `repo_push=yes`, `push_probe=ok`
   (it created and deleted the branch `kortix/identity-check`),
   `author_linked=yes`, `probe_branch=deleted`, `errors=none`. Fix and run it
   again:

   | Result | Fix |
   |---|---|
   | `errors=no-token` | the person has not pasted it yet: give the link again |
   | `errors=token-rejected` | a mistyped, expired or unapproved token: step 3, then step 4 |
   | `repo_push=no`, `errors=no-write-access` | step 2, or the token does not include the repository |
   | `push_probe=failed:rule` | a ruleset or branch protection covers `kortix/*`: the person allows the bot to create those branches |
   | `push_probe=failed:workflow` | the token lacks the Workflows permission |
   | `author_linked=no` | set `identity.email` to `<id>+<login>@users.noreply.github.com` from the run line |

6. Write `identity.github_login`, `identity.name` and `identity.email` from
   the run line into `factory.json`, commit
   `chore(factory): pin the factory's GitHub identity` and push it the way
   `kortix ship` does. From now on every factory shell refuses another account
   (`errors=wrong-identity`).

### D. After guide step 6: the store

`kortix onboard` (guide step 6) covers this template: it creates two GitHub
webhooks, `issues` → `source-github-issues` and `pull_request_review`,
`pull_request_review_comment`, `issue_comment` → `factory-feedback-github`,
both with `FACTORY_GITHUB_WEBHOOK_SECRET`. Then:

- GitHub Issues: create the labels `factory`, `kortix`, `factory:triage`,
  `factory:ready`, `factory:in-progress`, `factory:in-review`,
  `factory:blocked`, `priority:1` … `priority:4`, `needs-review`,
  `do-not-merge` (`gh label create <name> --force`).
- Linear, Jira or Asana: connect it (`kortix connectors add <slug>`, or
  `kortix secrets request <TOKEN> --scope runtime` for the API token), create
  the `factory` label, read the state, status or section ids and write them
  into `store.states` (`references/stores/<kind>.md` names them).
- JSON file: create the branch with `{"version":1,"next_id":1,"tickets":[]}`.

### E. The sources

For each enabled source, follow its reference's setup and request its
credentials by name only (`kortix secrets request <NAME> --scope runtime`).
Refuse any production write credential.

| Source | Setup |
|---|---|
| `errors` | `sources/errors-<tracker>.md`. Poll: the token only. Push: `kortix triggers info source-errors --json` gives `webhook_url`; set it in the tracker with `Authorization: Bearer <FACTORY_ERRORS_WEBHOOK_SECRET>` and send one test alert |
| `logs-anomaly` | `sources/logs-anomaly.md`: one read-only credential per backend in `sources.logs-anomaly.backends` |
| `db-observer` | `sources/db-observer.md`: the person creates the read-only role with the SQL there (or a Supabase token); never the application's own URL |
| `slack` | `sources/slack.md` setup: Slack connected, the bot joins each public channel itself, the person types `/invite @Kortix` in each private one |
| `customer-feedback` | `sources/customer-feedback.md`: one entry per channel in `sources.customer-feedback.channels` and its read credential; a feedback form gets the `source-customer-feedback-webhook` URL with `Authorization: Bearer <FACTORY_FEEDBACK_WEBHOOK_SECRET>` |

Fire each enabled source once (`kortix triggers fire <slug> --wait 300s`)
and read its run line in `kortix triggers runs <slug>`: `errors=none`, and
`created=0` is a valid first result.

### F. In guide step 7: prove one ticket end to end

0. **First wait for the dev image**: `kortix sandboxes build <slug> --wait`, then
   `kortix doctor --loops --json` until `ready: true` (add
   `--repo <owner>/<repo>` when the config lives in its own repository and
   the triggers carry no `body.repository.full_name` filter). A worker
   started on an unbuilt image runs on the platform default and cannot boot the app.
   The reviewer should run on the strongest connected model: when `models.reviewer`
   and `models.worker_hard` are null and a stronger model than the workspace
   default is connected (`kortix models ls`), set them in `factory.json` unless
   the person said no in guide step 3.
1. Use the task the person approved in guide step 3: one tiny, real change
   (a typo, a missing test, a small bug) you found in the analysis.
2. File it in the store as a person would: on GitHub Issues,
   `gh issue create --title "<title>" --body "<what, where, expected>" --label kortix`.
   The webhook fires `source-github-issues`; confirm with
   `kortix triggers runs source-github-issues`.
3. `kortix triggers fire factory-intake --wait 300s`. Give the person the
   worker session link from the `[factory-intake] claimed` comment.
4. Wait for the `[factory-worker] handoff` comment (up to ~30 min). Open the
   pull request with the person: the **Review in 60 seconds** section, the
   commands with their real output, the demo when the change is visible.
5. Prove the identity on the real pull request:
   `gh pr view <n> --json author,commits --jq '.author.login, [.commits[] | .authors | map(.login)]'`
   prints `identity.github_login` as the pull request's author and as the
   first author of every commit; the person's login follows as the co-author
   (the `Co-authored-by:` trailer, because the person filed the issue).
6. `kortix triggers fire factory-merge --wait 300s`. Under `hold`, the pull
   request gets `needs-review` and one held comment: the person merges it.

### G. Add to the guide's step 9 report

- The factory's GitHub account (`identity.github_login`), the token's expiry
  date, and that `factory-identity` re-checks it every Monday and files a
  blocked ticket 14 days before it expires.
- The store and its link; the enabled sources with their schedules; the merge
  policy and how to change it (`merge.policy` in factory.json).
- How to hand work to the factory: label a GitHub issue `kortix` (or assign the
  agent user in Linear, Jira or Asana).
- The caps: at most `caps.workers` workers at once, at most 5 new tickets per
  source per day.
- What every loop costs: intake runs every 5 minutes, one short turn when
  there is nothing to do. Change `factory-intake`'s `cron` to run less often.
