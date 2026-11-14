# Feedback: a person's review goes back to the same worker

Triggers `factory-feedback` (every 10 minutes) and `factory-feedback-github`
(a GitHub review or comment, at once). Both run in one keyed session. Feedback
writes one ticket comment and one pull request comment per feedback batch. It
never pushes, merges, resolves a thread or posts to chat.

## Candidates

Every open factory pull request whose ticket's newest cycle marker is a
`[factory-worker] handoff` naming it. The webhook run takes only the pull
request or ticket of its event; it is not a factory pull request or ticket:
end with `candidates=0`.

## Collect, newer than the watermark

The watermark is the newer of the handoff time and the `through=` of the
newest `[factory-feedback] requested` on the ticket.

| Item | Counts when |
|---|---|
| pull request comment | the author is a person (`user.type == "User"`, not the token's login, not ending in `[bot]`) |
| review body | state `COMMENTED` or `CHANGES_REQUESTED`, a non-empty body, by a person |
| inline review comment | in an unresolved thread, by a person |
| ticket comment | by a person, not starting with `[factory-` |
| review rejection | the newest `[factory-review] request_changes` names the current head and no feedback batch carries it yet |
| evidence failure | the merge gate's `held · G5` for the current head |

```sh
gh api graphql -F owner=<o> -F name=<r> -F n=<n> -f query='query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){headRefOid comments(last:100){nodes{url createdAt body author{login __typename}}} reviews(last:50){nodes{url state submittedAt body author{login __typename}}} reviewThreads(last:100){nodes{isResolved comments(first:50){nodes{url createdAt body author{login __typename}}}}}}}}'
```

The factory's own comments are never feedback, whatever they say (check the
author first, the `[factory-` prefix second).

## Classify

- **actionable**: asks for a change, reports a bug or a failing case, asks for
  a missing test or demo, objects to the design, or asks a question the pull
  request must answer. A `CHANGES_REQUESTED` review, a review rejection and an
  evidence failure are always actionable. Unsure: actionable.
- **not actionable**: approval, thanks, `LGTM`, an emoji, a status note.

No actionable item: write nothing.

## Request

1. Re-read the ticket. Another run already wrote a batch through this item:
   stop.
2. `ticket.assign(agent)` (stores with assignees).
3. `ticket.comment`:
   ```
   [factory-feedback] requested · PR <url> · items=<n> · through=<ISO time of the newest item>
   - <PR|review|thread|ticket|review-rejection|evidence>: <one-line paraphrase, no names> — <link>
   ```
   At most 8 bullets, actionable first, oldest first.
4. `gh pr comment <n> --body "[factory-feedback] picked up · <n> items — the factory worker continues on this branch."`
5. Intake resumes the pull request's own worker on its next pass (at most
   5 minutes). To start it now: `kortix triggers fire factory-intake`.

## Run line

```
factory-feedback: candidates=<n> requested=<n> items=<n> non_actionable=<n> errors=<none|codes>
```
