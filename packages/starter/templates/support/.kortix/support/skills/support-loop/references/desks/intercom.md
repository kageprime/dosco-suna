# Desk: Intercom

`desk.kind: intercom`, `desk.target: <app id>` (for links only).

## Access, first match wins

1. The `intercom` connector: `kortix connectors show intercom` once per
   session, then `kortix connectors call intercom <tool> '<json>' --json`.
2. The secret `INTERCOM_ACCESS_TOKEN`: REST at `https://api.intercom.io`,
   headers `Authorization: Bearer $INTERCOM_ACCESS_TOKEN`,
   `Accept: application/json`, and `Intercom-Version: <version>`. Read the
   current version name from Intercom's API reference
   (`https://developers.intercom.com`) once at setup and write it into
   support.json `desk.api_version`. A reply on a region workspace (EU, AU)
   uses that region's host, as the reference names it.

## Operations

| Operation | REST call |
|---|---|
| `desk.context` | `GET /me`: the admin id the loop acts as; write it into support.json `desk.admin_id` |
| `conversation.list_updated(since)` | `POST /conversations/search` with `{"query":{"operator":"AND","value":[{"field":"state","operator":"=","value":"open"},{"field":"updated_at","operator":">","value":<since unix seconds>}]},"pagination":{"per_page":50}}`; follow `pages.next.starting_after` into a file |
| `conversation.get(id)` | `GET /conversations/<id>`: `source` and `conversation_parts` |
| `note.add(id, body)` | `POST /conversations/<id>/reply` with `{"message_type":"note","type":"admin","admin_id":"<desk.admin_id>","body":"<body>"}` |
| `note.list(id)` | the `conversation_parts` whose `part_type` is `note` |
| `tag.add(id, tag)` | `POST /conversations/<id>/tags` with `{"id":"<tag id>","admin_id":"<desk.admin_id>"}`; create the tags once at setup (`POST /tags`) |
| `draft.create(id, body)` | a note whose first line is `[support-loop] draft` (the API has no reply drafts) |
| `reply.send(id, body)` | `POST /conversations/<id>/reply` with `"message_type":"comment"`; only under §6 |
| `conversation.mark_done(id)` | `POST /conversations/<id>/parts` with `{"message_type":"close","type":"admin","admin_id":"<desk.admin_id>"}` |

Intercom answers `429` with a reset header: wait until the reset, once, then
end the run (contract §1 rule 11).
