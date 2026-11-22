# Desk: a JSON file in a private repository

`desk.kind: json-file`, `desk.target: <owner>/<private repo>:<branch>:<path>`,
for example `acme/support-desk:desk:conversations.json`. Choose it to try the
loop before a desk is connected, and for the first proof in onboarding. In-app
feedback that arrives by webhook is stored here when no desk is set.

**Never the code repository, never a public repository.** The file holds
customer messages. Setup creates a private repository
(`gh repo create <owner>/support-desk --private`). Every run checks
`gh repo view <repo> --json visibility --jq .visibility` is `PRIVATE` before
the first read and stops with `errors=desk-not-private` when it is not.

## Shape

```json
{
  "version": 1,
  "conversations": [
    {
      "id": "C-1",
      "channel": "feedback",
      "status": "open",
      "subject": "Export to CSV shows an empty file",
      "customer": { "ref": "<customer ref>", "plan": "team" },
      "updated_at": "2026-01-01T00:00:00Z",
      "messages": [{ "from": "customer", "at": "2026-01-01T00:00:00Z", "text": "…" }],
      "notes": [{ "at": "2026-01-01T00:05:00Z", "body": "[support-loop] triaged · bug · 2 · confidence 0.80\n…\nsupport-key: conv:json-file:C-1" }],
      "tags": ["bug"]
    }
  ]
}
```

The values above are synthetic. A person answers a conversation by adding a
message with `"from": "team"` and setting `status`.

## Write protocol: one commit per operation

```sh
W=/tmp/support/desk && B=<branch> && F=<path>
[ -d $W/.git ] || gh repo clone <owner>/<repo> $W -- --single-branch --branch $B --depth 1
git -C $W fetch -q origin $B && git -C $W reset -q --hard origin/$B
# change $W/$F with jq into a temp file, then move it over $F
git -C $W commit -qam "support: <operation> <conversation id>" && git -C $W push -q origin HEAD:$B
```

A rejected push: fetch, reset, apply again, push. Three rejections: end the
run with `errors=desk-busy`. Commit messages hold the id and the operation
only, never message text.

## Operations

| Operation | Implementation |
|---|---|
| `desk.context` | the visibility check, then the file parses and `version` is `1` |
| `conversation.list_updated(since)` | `.conversations[]` with `status == "open"` and `updated_at > since` |
| `conversation.get(id)` | `.conversations[] \| select(.id == id)` |
| `note.add` / `note.list` | append to / read `.notes[]` |
| `tag.add` | append to `.tags[]` once |
| `draft.create` | a note whose first line is `[support-loop] draft` |
| `reply.send` | append a message with `"from": "agent"`; nothing leaves the file. Only under §6 |
| `conversation.mark_done` | `status: "done"` |
| new feedback (the webhook source) | append a conversation with the next `C-<n>` id |
