# Source: the desk queue (poll)

Trigger `support-queue` (cron, every 15 minutes, keyed session). Disabled
until setup writes `desk.kind` and sets `sources.queue.enabled: true`.

Why a poll and not the desk's own webhook: a Kortix webhook trigger accepts a
GitHub signature or `Authorization: Bearer <secret>`. Plain, Intercom and
Zendesk sign their webhooks with their own schemes, so the loop reads the
queue on a schedule instead. A desk that can send a custom
`Authorization: Bearer` header may call `support-feedback` with
`"kind": "feedback"` too; the queue poll still runs as the safety net.

## Cursor

The cursor is the newest `updated_at` the last run finished. It lives in one
internal place per desk, never in the config repository:

- `json-file`: the field `cursor` at the top of the file.
- every other desk: the keyed session's memory is not authoritative. Read
  `kortix triggers runs support-queue --json`, take the newest run with
  `errors=none`, and use its start time minus 15 minutes. The overlap is safe:
  the `triaged` marker (contract §5 step 1) skips what was already done.

## Run

1. `desk.context`. Fails: end with `errors=credential`.
2. `conversation.list_updated(cursor)` into `/tmp/support/queue/updated.json`.
   Count the open backlog for the run line.
3. Newest first, up to `caps.conversations_per_run`: run contract §5 for each
   conversation whose newest message is from the customer. A conversation
   whose newest message is from the team: skip, nothing to do.
4. Update the cursor (json-file only).
5. End with `support-queue:` and the contract run line. Nothing to do:
   `read=0` and no write.
