# Desk: a shared mailbox

`desk.kind: email`, `desk.mailbox: <support address>`. Choose it when the
team answers support from a mailbox and has no help desk.

## Access

The mail connector (`gmail` by default; `sources.inbox.connector` names
another): `kortix connectors show <slug>` once per session for the tool names
(search messages, read a thread, create a draft, add a label, send). Before
the first call, read the connected account's profile and check that its
address equals `desk.mailbox`. Another address: stop with
`errors=wrong-mailbox`. Never read another mailbox.

## Operations

| Operation | Implementation |
|---|---|
| `desk.context` | the profile check above |
| `conversation.list_updated(since)` | search the inbox for threads with a message after `since`, excluding spam, trash and sent-only threads, into a file |
| `conversation.get(id)` | read the thread: subject, messages, labels |
| `note.add(id, body)` | a mailbox has no internal notes: a draft in the thread whose first line is `[support-loop] note` and which nobody sends; the Review output carries the same text |
| `note.list(id)` | the drafts in the thread whose first line starts with `[support-loop]` |
| `tag.add(id, tag)` | add the label `support/<tag>`; create it once at setup |
| `draft.create(id, body)` | the create-draft tool, as a reply in the thread; never the send tool in `draft` mode |
| `reply.send(id, body)` | the send tool, as a reply in the thread; only under §6 |
| `conversation.mark_done(id)` | remove the inbox label (archive); never delete |

A sent reply is real only when the re-read thread holds it with the `SENT`
label (or the connector's equivalent).
