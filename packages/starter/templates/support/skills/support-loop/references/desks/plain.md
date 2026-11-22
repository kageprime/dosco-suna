# Desk: Plain

`desk.kind: plain`, `desk.target: <workspace id>` (for links only).

## Access, first match wins

1. The `plain` connector: `kortix connectors show plain` once per session for
   the tool names and argument shapes, then
   `kortix connectors call plain <tool> '<json>' --json`.
2. The secret `PLAIN_API_KEY`: GraphQL at
   `https://core-api.uk.plain.com/graphql/v1`, header
   `Authorization: Bearer $PLAIN_API_KEY`, `Content-Type: application/json`.

Plain answers HTTP 200 with an `errors` array, and every mutation returns its
own `error` field. Check both. A field or an input below that Plain rejects:
read Plain's schema reference (`https://www.plain.com/docs`) once and adapt
the query, never the operation.

## Queries

```graphql
query Updated($after: String) {
  threads(filters: { statuses: [TODO] }, first: 50, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    edges { node { id title status updatedAt { iso8601 } customer { id } labels { labelType { name } } } }
  }
}
query Thread($id: ID!) {
  thread(threadId: $id) {
    id title status customer { id }
    timelineEntries(first: 20) { edges { node { timestamp { iso8601 } entry { __typename ... on EmailEntry { textContent } ... on ChatEntry { text } ... on NoteEntry { text } } } } }
  }
}
mutation Note($input: CreateNoteInput!) { createNote(input: $input) { note { id } error { message code } } }
mutation Reply($input: ReplyToThreadInput!) { replyToThread(input: $input) { error { message code } } }
mutation Done($input: MarkThreadAsDoneInput!) { markThreadAsDone(input: $input) { error { message code } } }
```

## Operations

| Operation | Implementation |
|---|---|
| `desk.context` | a `threads(first: 1)` query answers without `errors` |
| `conversation.list_updated(since)` | `Updated`, paged into a file; keep threads whose `updatedAt.iso8601` is after `since`. Plain sorts newest first only when asked: sort the file yourself |
| `conversation.get(id)` | `Thread` |
| `note.add(id, body)` | `Note` with `{ threadId, customerId, markdown: body }` |
| `note.list(id)` | the `NoteEntry` items of `Thread` |
| `tag.add(id, tag)` | the label tool or mutation the connector lists (`addLabels` with a label type id created once at setup); none: a note line `tags: <tag>` |
| `draft.create(id, body)` | `Note` whose first line is `[support-loop] draft` (Plain has no reply drafts) |
| `reply.send(id, body)` | `Reply` with `{ threadId, textContent, markdownContent }`; only under §6 |
| `conversation.mark_done(id)` | `Done` with `{ threadId }`, a separate call after the reply; `replyToThread` does not mark done |

A link for a Review item: `https://app.plain.com/workspace/<desk.target>/thread/<id>` when `desk.target` is set; otherwise the thread id.
