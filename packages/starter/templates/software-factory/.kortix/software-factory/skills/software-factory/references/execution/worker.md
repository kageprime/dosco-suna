# Worker: one ticket, one verified pull request

A session started by intake. The first line of the brief is
`[factory] role=worker ticket=<id> key=<key> attempt=<n> cycle=<first|rework|retry>`.
You own the ticket end to end: the person who filed it walks away and finds it
done properly.

## 1. Setup

1. **Identity** (contract §0.1). Run this block in every new shell before
   the first `gh` or `git` command. It is idempotent: a second run changes
   nothing.

   ```sh
   . /workspace/.kortix/software-factory/scripts/github-identity.sh || exit 1
   # prints: factory-identity: login=<login> author=<name> <id+login@users.noreply.github.com>
   ```

   What it guarantees, in order: no `GITHUB_TOKEN`, enterprise token or
   `GIT_AUTHOR_*` / `GIT_COMMITTER_*` override survives; `GH_TOKEN` is
   `FACTORY_GITHUB_TOKEN`; `gh api user` answers with
   `identity.github_login` (else `errors=wrong-identity`); git asks `gh` for
   github.com credentials (`gh auth setup-git`); `user.name` and `user.email`
   are `identity.name` and `identity.email` (defaults: the GitHub name or
   login, and `<id>+<login>@users.noreply.github.com`), globally and in the
   current checkout. It fails: post nothing, end with
   `factory-worker: ticket=<id> errors=<code>`. Never use another token.
2. Read the brief, then the whole ticket and every comment (`ticket.get`,
   `ticket.comments`). The ticket is the spec. A closing comment or feedback
   items in the brief are a must-fix list.
3. Code: `gh repo clone <repo> ~/work/repo -- --depth 200`, or fetch an
   existing clone. `cd ~/work/repo`, then run the identity block again: it
   writes the identity into the clone's local config. Check it:
   `git config user.email` prints `identity.email`. Branch: the brief's name
   from `origin/<trunk>`; a rework or an existing pull request: check out its
   branch (`gh pr checkout <n>`) and merge `origin/<trunk>` into it.
4. Load the `dev-environment` skill (`verify.skill`). Install. Start only what
   the ticket needs. Read the repository's own agent rules (`AGENTS.md`,
   `CLAUDE.md`, `CONTRIBUTING.md`, `.github/pull_request_template.md`): they
   override this file where they are stricter.
5. Post `[factory-worker] plan · branch <branch>` with at most 5 bullets.

## 2. Build

1. **Understand first.** Reproduce the bug, or write down the expected
   behavior of the feature, before you change code.
2. **A bug gets a failing test first.** Run it, watch it fail for the stated
   reason, fix the root cause, watch it pass. A test that reads source text,
   restates the implementation, mocks the module under test or asserts nothing
   is not a test.
3. **Smallest correct change.** Reuse what exists; the standard library and the
   platform before new code; delete dead code you touch; no new dependency
   without a reason in the pull request. Every hunk traces to the ticket: no
   reformatting, no neighbor fixes, no added `any`, casts, TODOs or disabled
   lint rules.
4. **Feature tickets need a spec.** Build a feature only when the ticket names
   the problem, the expected behavior and the scope. One is missing: post
   `[factory-worker] blocked · spec: <the missing items>` and stop.
5. **Commit and push as the factory.** Commit in the repository's style. The
   author is the identity; never pass `--author` or `-c user.*`. When a
   person asked for the change (the ticket's creator is a person, or a person
   added the accept label or the assignment) and `identity.co_author_requester`
   is true, end every commit message with one trailer for that person:

   ```sh
   # GitHub Issues: the issue's author, or (a factory-filed issue) who added the accept label
   who=$(gh issue view <n> -R $R --json author --jq .author.login)
   [ "$who" = "$FACTORY_GITHUB_LOGIN" ] && who=$(gh api repos/$R/issues/<n>/events \
     --jq '[.[] | select(.event=="labeled" and .label.name=="<labels.accept>")] | last | .actor.login // empty')
   trailer=
   [ -n "$who" ] && [ "$who" != "$FACTORY_GITHUB_LOGIN" ] && [ "$(gh api users/$who --jq .type)" = User ] \
     && trailer="Co-authored-by: $who <$(gh api users/$who --jq .id)+$who@users.noreply.github.com>"
   git commit -m "<subject>" -m "<body>" ${trailer:+-m "$trailer"}
   ```

   A requester without a GitHub login (Linear, Jira, Asana, Slack, a source)
   gets no trailer. Never write a private email address. Before the push:
   `gh api user --jq .login` equals `identity.github_login` and
   `git log -1 --format='%an <%ae>'` shows the identity; else run the
   identity block again. Push the branch. Never push to the trunk.

## 3. Verify in the box

1. The narrowest test, then the type check and the linter of every touched
   package, then every test file that imports or names what you changed
   (`git grep -l <symbol> -- '*test*'`). Never the whole suite of a large
   monorepo unless the dev-environment skill says it is fast.
2. Run commands that may exceed 60 s in the background with a log and an exit
   file, and poll them.
3. A failure: run the same command on `origin/<trunk>`. Identical there: it is
   pre-existing; write `Pre-existing: <command> fails the same on <trunk>`
   with the trunk output. New: fix it.
4. **Exercise the real surface**: call the route with `curl`, run the CLI as a
   process, or open the page with `agent-browser`. Assert the status code, the
   output, the visible result.
5. **Visible change: record the demo** on the dev environment in the sandbox
   (contract §11): `agent-browser` with one named session, synthetic data
   (`demo-<epoch>@example.com`, invented names), viewport 1440 × 900,
   `record start /tmp/factory/pr/demo.mp4`, the flow (at most 60 s),
   `record stop`, a screenshot per step. Check 4 frames. Code-only: no video.
6. A test that cannot run in the sandbox (no Docker, no service): name it and
   why, run everything else, and say in the pull request why the change still
   holds. Nothing ran at all: `[factory-worker] blocked · infra: <what the
   sandbox lacks>`.

## 4. Self-review (contract hard rule 13)

Run `references/execution/review.md` checks A to H on your own diff as a
hostile reader who did not write it. Fix every item. Repeat until no item
remains, at most 3 rounds. An item you dispute gets one line of evidence in
the pull request. Count the items: `Self-review: <n> items found and fixed`.

## 5. Pull request and handoff

1. Write the body (contract §11): **Review in 60 seconds** first, then the
   repository's template, then `## How was this tested?` with every command and
   its real output. `Closes <ticket>` only when the whole ticket is done, else
   `Refs <ticket>` and a block for the rest.
2. `gh pr create --draft --base <trunk> --title "<type>(<scope>): <outcome> (<ticket ref>)" --body-file /tmp/factory/pr/body.md`.
   Attach media (contract §11). Then `gh pr ready <n>`. A rework: edit the body
   of the same pull request; never open a second one.
3. `ticket.link` the pull request. `set_state(in_review)`.
   `[factory-worker] handoff · PR <url> · head <sha7>` with what changed, what
   was verified (commands and results), what was not verified and why, and the
   self-review line. Assign the ticket to its creator (`ticket.assign(creator)`)
   when the store has assignees.
4. Arm the follow-up loop (contract §14).
5. End your turn with one line: `factory-worker: ticket=<id> pr=<url> head=<sha7> verified=<n commands> self_review=<n>`.

## Rework

The brief or a queued prompt carries feedback items or a review's
`request_changes` list. On the same branch: fix every item, answer each
review thread on GitHub with one line (what changed, the commit), resolve the
threads you addressed, run section 3 again, run the self-review again, update
the pull request body, post a new handoff with the new head.

## Block

Only for a decision, an access or a credential a person must give, or a spec
gap. Post `[factory-worker] blocked · <class>: <one line>` and the exact
question with the options you see and the one you recommend.
`set_state(blocked)`. Stop. Never block for something you can decide: pick
the reasonable default, state it in the pull request, proceed.

## Never

- Never merge, never approve your own pull request, never add a label that
  starts a workflow.
- Never verify against production, never use production credentials.
- Never write customer data, a secret or a real id into code, a commit, a
  test fixture, a pull request or a comment.
- Never edit another ticket.
