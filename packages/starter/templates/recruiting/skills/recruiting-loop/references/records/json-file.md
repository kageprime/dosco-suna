# Record: a JSON file in a private repository

`record.kind: json-file`, `record.target: <owner>/<private repo>:<branch>:<path>`,
for example `acme/hiring-ledger:ledger:candidates.json`. Choose it when the
team uses no ATS yet, or for the first proof of the template.

**Never the code repository, never a public repository.** The file holds
candidates' names, emails and scorecards. Setup creates a private repository
for it (`gh repo create <owner>/hiring-ledger --private`) and checks
`gh repo view <repo> --json visibility --jq .visibility` is `PRIVATE` before
the first write. Every run checks it again and stops with
`errors=ledger-not-private` when it is not. Only the people who hire may read
the repository.

## Shape

```json
{
  "version": 1,
  "candidates": {
    "cand:3f2a9c0d1e4b:example-role": {
      "role": "example-role",
      "name": "Sam Example",
      "email": "sam@example.com",
      "source": "application",
      "received_at": "2026-01-01T00:00:00Z",
      "resume_text": "…",
      "answers": [{ "id": "work-authorization", "text": "Yes" }],
      "stage": "new",
      "owner": null,
      "notes": [
        { "at": "2026-01-01T00:00:00Z", "body": "[recruiting-loop] screened · role example-role · score 78 · strong\n…\nrecruiting-key: cand:3f2a9c0d1e4b:example-role" }
      ]
    }
  }
}
```

The values above are synthetic. A person edits the file to set a `stage` or
an `owner`. The loop never changes `stage`.

## Write protocol: one commit per operation

```sh
W=/tmp/recruiting/ledger && B=<branch> && F=<path>
[ -d $W/.git ] || gh repo clone <owner>/<repo> $W -- --single-branch --branch $B --depth 1
git -C $W fetch -q origin $B && git -C $W reset -q --hard origin/$B
# change $W/$F with jq into a temp file, then move it over $F
git -C $W commit -qam "recruiting: <operation> <key>" && git -C $W push -q origin HEAD:$B
```

A rejected push: fetch, reset, apply the change again, push. Three rejections:
end the run with `errors=ledger-busy`. Commit messages hold the key and the
operation only, never a name or an email. Delete `/tmp/recruiting/ledger` at
the end of the run.

## Operations

| Operation | Implementation |
|---|---|
| `record.context` | the visibility check, then the file parses and `version` is `1` |
| `job.list()` | `roles[]` in recruiting.json with `open: true` |
| `candidate.find(email)` | the entries whose key starts with `cand:<sha1-12 of the email>:` |
| `candidate.create(fields)` | add `.candidates[<key>]` with `stage: "new"` |
| `application.list(since)` | entries with `received_at` after `since` |
| `application.get(id)` | `.candidates[<key>]` |
| `note.add` / `note.list` | append to / read `.candidates[<key>].notes[]` |
| `record.erase(candidate)` | delete `.candidates[<key>]`; the commit message is `recruiting: erase <key>` |

Erasing removes the entry from the file, not from Git history. Setup tells
the person: to erase the history too, squash the ledger branch (one commit
that holds the current file) once a month.
