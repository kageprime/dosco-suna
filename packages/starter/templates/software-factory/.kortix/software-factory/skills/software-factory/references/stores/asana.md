# Store: Asana

`store.kind: asana`, `store.target: <project gid>`. `store.agent_identity`: the
gid of the Asana user the factory acts as. `store.states` maps each factory
state to a **section gid** of the project (Asana has no workflow states).

## Access, first match wins

1. The `asana` connector: `kortix connectors show asana`, then
   `kortix connectors call asana <tool> …`.
2. The secret `ASANA_ACCESS_TOKEN` (a personal access token of the factory
   user): `curl -s https://app.asana.com/api/1.0/… -H "Authorization: Bearer $ASANA_ACCESS_TOKEN"`.

## Conventions

- **States are sections**: one section per open factory state (`Triage`,
  `Ready`, `In progress`, `In review`, `Blocked`). The setup creates them and
  writes their gids into `store.states`. `done` = `completed: true` in the
  `Done` section; `canceled` = `completed: true` plus the tag `factory:canceled`.
- **Labels are tags** in the workspace: `factory`, `source:<s>`, `kind:<k>`.
- **Priority** is a custom enum field `Priority` when the project has one
  (`store.states.priority_field`), else a tag `priority:<n>`.
- The body is `notes` (plain text); the key line is its last line.

## Operations

| Operation | Implementation |
|---|---|
| `store.context` | `GET /users/me` (gid must equal `store.agent_identity`); `GET /projects/<gid>/sections` |
| `label.ensure(name)` | `GET /workspaces/<ws>/tags?opt_fields=name`; missing: `POST /workspaces/<ws>/tags` |
| `ticket.find_by_key(key)` | `GET /workspaces/<ws>/tasks/search?projects.any=<gid>&text=factory-key: <key>&opt_fields=notes,completed,memberships.section.name` (search needs a paid workspace; otherwise read `ticket.list` with completed tasks and match in code) |
| `ticket.list(filter)` | `GET /projects/<gid>/tasks?completed_since=now&opt_fields=name,notes,tags.name,assignee,memberships.section.gid,modified_at,created_at`, paged with `offset`, into a file |
| `ticket.get(id)` | `GET /tasks/<gid>?opt_fields=name,notes,completed,tags.name,assignee,created_by,memberships.section.gid,permalink_url` |
| `ticket.comments(id)` | `GET /tasks/<gid>/stories?opt_fields=type,text,created_at,created_by` (keep `type: comment`) |
| `ticket.create(fields)` | `POST /tasks` with `projects`, `name`, `notes`, `tags`, `assignee`, `memberships: [{project, section: <triage section>}]` |
| `ticket.update(id, fields)` | `PUT /tasks/<gid>`; tags with `POST /tasks/<gid>/addTag` and `removeTag` |
| `ticket.comment(id, body)` | `POST /tasks/<gid>/stories` with `text` |
| `ticket.set_state(id, s)` | `POST /sections/<section gid>/addTask` with `task`; `done`/`canceled`: also `PUT /tasks/<gid>` `completed: true` |
| `ticket.assign(id, who)` | `PUT /tasks/<gid>` with `assignee` |
| `ticket.claim(id, session)` | `set_state(in_progress)`, `assign(agent)`, the claimed comment |
| `ticket.link(id, url, title)` | a comment `<title>: <url>` |
| `ticket.reopen(id)` | `PUT /tasks/<gid>` `completed: false`, then `set_state(triage)` |
| `ticket.cancel(id, marker)` | the comment, the tag `factory:canceled`, then `completed: true` |

Rate limit: 150 requests per minute on a free workspace. A `429` carries
`Retry-After`: wait that long once, then follow the contract failure rule.
