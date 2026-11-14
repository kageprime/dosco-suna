# Store: Jira

`store.kind: jira`, `store.target: <project key>` (for example `ENG`).
`store.agent_identity`: the account id of the Jira user the factory acts as.

## Access, first match wins

1. The `jira` (Atlassian) connector: `kortix connectors show jira` once per
   session for the tool names, then `kortix connectors call jira <tool> …`.
2. The secrets `JIRA_BASE_URL` (`https://<site>.atlassian.net`), `JIRA_EMAIL`
   and `JIRA_API_TOKEN`: REST v3 with basic auth, passed through a curl config
   on stdin so the token never appears in an argument:
   `printf 'user = "%s:%s"\n' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | curl -s -K - -H 'Content-Type: application/json' "$JIRA_BASE_URL/rest/api/3/…"`.

Jira bodies are Atlassian Document Format (ADF). Write a body as one ADF
`codeBlock` or as paragraphs; read it with `renderedFields` or by walking the
ADF text nodes. The key line is the last paragraph: `factory-key: <key>`.

## State mapping

Jira states are workflow transitions. Read them per issue:
`GET /rest/api/3/issue/<key>/transitions`. Map by status category, unless
`store.states` names a status:

| Factory state | Jira status |
|---|---|
| `triage` | `store.states.triage`, else the first status of category `To Do` |
| `ready` | `store.states.ready`, else `To Do` |
| `in_progress` | category `In Progress` |
| `in_review` | `store.states.in_review`, else `In Progress` plus label `factory:in-review` |
| `blocked` | `store.states.blocked`, else `To Do` plus label `factory:blocked` |
| `done` | category `Done`, resolution `Done` |
| `canceled` | category `Done`, resolution `Won't Do` (or `store.states.canceled`) |

A transition that is not available from the current status: move through the
shortest available path; still impossible: comment and name it in the run line.

## Operations

| Operation | Implementation |
|---|---|
| `store.context` | `GET /rest/api/3/myself` (`accountId` must equal `store.agent_identity`); `GET /rest/api/3/project/<key>` |
| `label.ensure(name)` | Jira labels need no creation; nothing to do |
| `ticket.find_by_key(key)` | `GET /rest/api/3/search/jql?jql=project=<P> AND text ~ "\"factory-key: <key>\""&fields=status,description,resolution`; keep exact last-line matches |
| `ticket.list(filter)` | `jql=project=<P> AND labels = factory AND statusCategory != Done`, paged with `nextPageToken`, into a file |
| `ticket.get(id)` | `GET /rest/api/3/issue/<key>?fields=summary,description,status,labels,assignee,creator,priority` |
| `ticket.comments(id)` | `GET /rest/api/3/issue/<key>/comment?orderBy=created` |
| `ticket.create(fields)` | `POST /rest/api/3/issue` with `project`, `issuetype` (`Bug` for `kind:bug`, else `Task`), `summary`, `description` (ADF), `labels`, `priority` (`Highest`…`Low` for 1–4), `assignee.accountId` |
| `ticket.update(id, fields)` | `PUT /rest/api/3/issue/<key>` |
| `ticket.comment(id, body)` | `POST /rest/api/3/issue/<key>/comment` (ADF body) |
| `ticket.set_state(id, s)` | `POST /rest/api/3/issue/<key>/transitions` with the mapped transition id (and `resolution` for done or canceled) |
| `ticket.assign(id, who)` | `PUT /rest/api/3/issue/<key>/assignee` with `accountId` (null for none) |
| `ticket.claim(id, session)` | `set_state(in_progress)`, `assign(agent)`, the claimed comment |
| `ticket.link(id, url, title)` | `POST /rest/api/3/issue/<key>/remotelink` with `object: {url, title}` |
| `ticket.reopen(id)` | `set_state(triage)` |
| `ticket.cancel(id, marker)` | the comment, then `set_state(canceled)` |

The pull request names the issue key (`ENG-42`) in its title; the Jira GitHub
app links it when installed.
