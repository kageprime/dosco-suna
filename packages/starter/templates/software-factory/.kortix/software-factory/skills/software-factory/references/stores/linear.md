# Store: Linear

`store.kind: linear`, `store.target: <team key>` (for example `ENG`).
`store.agent_identity`: the email of the Linear user the factory acts as (a
dedicated member, never a person's own account).

## Access, first match wins

1. The `linear` connector: `kortix connectors show linear` once per session to
   read the tool names and argument shape, then
   `kortix connectors call linear <tool> '<json>' --json`. A GraphQL tool
   (`run_query_or_mutation` or similar) takes every query below.
2. The secret `LINEAR_API_KEY`:
   `curl -s https://api.linear.app/graphql -H "Authorization: $LINEAR_API_KEY" -H 'Content-Type: application/json' -d @<query.json>`.

Check every response for a top-level `errors` array and `success: true` on a
mutation. Linear answers HTTP 200 with `errors`.

**Linear pages comments newest first**: `comments(first: N)` is the newest N.
Sort by `createdAt` yourself.

## State mapping

Resolve states by `type`, never by name, lowest `position` first:

| Factory state | Linear state |
|---|---|
| `triage` | type `triage`; the team has none: type `backlog` |
| `ready` | type `unstarted` |
| `in_progress` | type `started` |
| `in_review` | type `started` whose name matches `/review/i`, else the `in_progress` state |
| `blocked` | the state named in `store.states.blocked`, else type `triage` plus the label `factory:blocked` |
| `done` | type `completed` |
| `canceled` | type `canceled` |

Assignment: `agent` = the viewer (it must equal `store.agent_identity`; else
stop with `errors=wrong-identity`), `creator` = the issue's creator, `none` =
null. A person hands a ticket over by assigning the agent user; prove it with
`history { nodes { actor { id } toAssignee { id } } }`: the newest entry that
assigns the agent has a person as actor.

## Queries

```graphql
query Ctx($key: String!) {
  viewer { id email }
  teams(filter: { key: { eq: $key } }) { nodes { id key states { nodes { id name type position } } } }
}
query Label($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id team { key } } } }
mutation LabelCreate($name: String!, $teamId: String!) { issueLabelCreate(input: { name: $name, teamId: $teamId }) { success issueLabel { id } } }
query ByKey($needle: String!) {
  issues(first: 10, includeArchived: true, filter: { description: { contains: $needle } }) {
    nodes { id identifier url description archivedAt completedAt canceledAt state { type } }
  }
}
query Open($teamId: ID!, $after: String) {
  issues(first: 50, after: $after, filter: { team: { id: { eq: $teamId } }, labels: { name: { eq: "factory" } },
         state: { type: { nin: ["completed", "canceled"] } } }) {
    pageInfo { hasNextPage endCursor }
    nodes { id identifier title priority createdAt updatedAt state { type name } assignee { id } creator { id }
            labels { nodes { name } } description }
  }
}
query Get($id: String!) {
  issue(id: $id) { id identifier url title description priority state { type } assignee { id } creator { id }
    labels { nodes { name } } comments(first: 100) { nodes { body createdAt user { id } } } }
}
mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }
mutation Update($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }
mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } } }
mutation Link($issueId: String!, $url: String!, $title: String!) { attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }
mutation Unarchive($id: String!) { issueUnarchive(id: $id) { success } }
```

## Operations

| Operation | Implementation |
|---|---|
| `store.context` | `Ctx` with `{key: store.target}`; exactly one team |
| `label.ensure(name)` | `Label`; none with `team == null` or this team: `LabelCreate` |
| `ticket.find_by_key(key)` | `ByKey` with `{needle: "factory-key: <key>"}`; keep exact last-line matches |
| `ticket.list(filter)` | `Open`, paged into `/tmp/factory/<role>/issues.json`; also the issues assigned to the viewer without the label (hand-overs) |
| `ticket.get(id)` / `ticket.comments(id)` | `Get` |
| `ticket.create(fields)` | `Create`: `teamId`, `title`, `description`, `priority` (1–4), `labelIds`, `stateId` (triage), `assigneeId` (viewer) |
| `ticket.update(id, fields)` | `Update` with `title`, `description`, `priority`, `labelIds` |
| `ticket.comment(id, body)` | `Comment` |
| `ticket.set_state(id, s)` | `Update` with `stateId` from the mapping |
| `ticket.assign(id, who)` | `Update` with `assigneeId` |
| `ticket.claim(id, session)` | `set_state(in_progress)`, `assign(agent)`, the claimed comment |
| `ticket.link(id, url, title)` | `Link` |
| `ticket.reopen(id)` | `Unarchive` when `archivedAt` is set, then `set_state(triage)` |
| `ticket.cancel(id, marker)` | `Comment`, then `set_state(canceled)` |

The pull request references the ticket by identifier in its title or body
(`Closes ENG-42`); the Linear GitHub integration links it when installed.
