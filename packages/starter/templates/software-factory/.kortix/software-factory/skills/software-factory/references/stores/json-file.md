# Store: a JSON file in Git

`store.kind: json-file`, `store.target: <owner>/<repo>:<branch>:<path>`, for
example `acme/shop:factory/tickets:tickets.json`. The file lives on its own
branch, never on the trunk, so ticket writes never touch the code. Choose it
when the team uses no tracker, or for private security findings on a public
repository.

## Shape

```json
{
  "version": 1,
  "next_id": 4,
  "tickets": [
    {
      "id": "T-3",
      "key": "tests:e2e:checkout-applies-coupon",
      "title": "[factory] Fix coupon total in checkout",
      "body": "## What\n…\n\nfactory-key: tests:e2e:checkout-applies-coupon",
      "state": "triage",
      "priority": 3,
      "labels": ["factory", "source:tests", "kind:bug"],
      "assignee": "agent",
      "created_by": "factory",
      "created_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z",
      "links": [{ "title": "PR", "url": "https://github.com/acme/shop/pull/12" }],
      "comments": [{ "author": "factory", "at": "2026-01-01T00:00:00Z", "body": "[factory-intake] claimed · attempt 1 · session <id>" }]
    }
  ]
}
```

`state` is one of the seven factory states. A person edits the file to hand a
ticket over (`"assignee": "agent"`, `"state": "ready"`) or to comment
(`"author": "<their name>"`).

## Write protocol: one commit per operation

Every write is read, change, commit, push, with the push as the lock:

```sh
W=/tmp/factory/store && B=<branch> && F=<path>
[ -d $W/.git ] || gh repo clone <owner>/<repo> $W -- --single-branch --branch $B --depth 1
git -C $W fetch -q origin $B && git -C $W reset -q --hard origin/$B
# change $W/$F with jq into a temp file, then move it over $F
git -C $W commit -qam "factory: <operation> <ticket id>" && git -C $W push -q origin HEAD:$B
```

A rejected push (someone wrote first): fetch, reset, apply the change again,
push again, at most 3 times. The branch does not exist: create it as an orphan
branch with `{"version":1,"next_id":1,"tickets":[]}`. Never force-push.

## Operations (jq over the file)

| Operation | Implementation |
|---|---|
| `store.context` | clone or fetch the branch; the agent identity is `factory` |
| `label.ensure(name)` | nothing: labels are strings |
| `ticket.find_by_key(key)` | `jq --arg k <key> '.tickets[] \| select(.key == $k)'` |
| `ticket.list(filter)` | `jq '[.tickets[] \| select(.state != "done" and .state != "canceled")]'` |
| `ticket.get(id)` / `ticket.comments(id)` | `jq --arg id <id> '.tickets[] \| select(.id == $id)'` |
| `ticket.create(fields)` | append `{id: "T-<next_id>", …, state: "triage", assignee: "agent"}`, increment `next_id` |
| `ticket.update(id, fields)` | replace those fields, set `updated_at` |
| `ticket.comment(id, body)` | append to `comments` |
| `ticket.set_state(id, s)` | set `state` |
| `ticket.assign(id, who)` | set `assignee` (`agent`, the creator, or null) |
| `ticket.claim(id, session)` | `state: in_progress`, `assignee: agent` and the claimed comment, in one commit |
| `ticket.link(id, url, title)` | append to `links` |
| `ticket.reopen(id)` | `state: triage` |
| `ticket.cancel(id, marker)` | the comment and `state: canceled`, in one commit |

The pull request names the ticket id (`Refs T-3`). Keep the file under about
2 MB: groom moves tickets that are `done` or `canceled` for 90 days into
`<path>.archive.json` on the same branch.
