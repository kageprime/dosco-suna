# Desk: Zendesk

`desk.kind: zendesk`, `desk.target: <subdomain>` (the `<subdomain>` of
`https://<subdomain>.zendesk.com`).

## Access, first match wins

1. The `zendesk` connector: `kortix connectors show zendesk` once per session,
   then `kortix connectors call zendesk <tool> '<json>' --json`.
2. The secrets `ZENDESK_SUBDOMAIN`, `ZENDESK_EMAIL` and `ZENDESK_API_TOKEN`:
   REST at `https://$ZENDESK_SUBDOMAIN.zendesk.com/api/v2`, Basic auth with
   the user `$ZENDESK_EMAIL/token` and the password `$ZENDESK_API_TOKEN`
   (`curl -u "$ZENDESK_EMAIL/token:$ZENDESK_API_TOKEN"`). The agent user is a
   dedicated agent seat, never a person's own account.

## Operations

| Operation | REST call |
|---|---|
| `desk.context` | `GET /users/me.json`: the role is `agent` or `admin` |
| `conversation.list_updated(since)` | `GET /search.json?query=type:ticket status<solved updated>"<since ISO time>"&sort_by=updated_at&sort_order=desc`, paged with `next_page` into a file |
| `conversation.get(id)` | `GET /tickets/<id>.json` and `GET /tickets/<id>/comments.json` |
| `note.add(id, body)` | `PUT /tickets/<id>.json` with `{"ticket":{"comment":{"body":"<body>","public":false}}}` |
| `note.list(id)` | the comments with `public: false` from `GET /tickets/<id>/comments.json` |
| `tag.add(id, tag)` | `PUT /tickets/<id>/tags.json` with `{"tags":["<tag>"]}` (adds, never replaces) |
| `draft.create(id, body)` | an internal note whose first line is `[support-loop] draft` |
| `reply.send(id, body)` | `PUT /tickets/<id>.json` with `"public": true`; only under §6 |
| `conversation.mark_done(id)` | `PUT /tickets/<id>.json` with `{"ticket":{"status":"solved"}}` |

The search API returns at most 1,000 results per query: a larger backlog is
read in several windows of `updated`.
