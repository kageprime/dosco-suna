# Record: a JSON file in a private repository

`record.kind: json-file`, `record.target: <owner>/<private repo>:<branch>:<path>`,
for example `acme/sales-ledger:ledger:leads.json`. Choose it when the team uses
no CRM yet.

**Never the code repository, never a public repository.** The file holds
people's names and work emails. Setup creates a private repository for it
(`gh repo create <owner>/sales-ledger --private`) and checks
`gh repo view <repo> --json visibility --jq .visibility` is `PRIVATE` before
the first write. Every run checks it again and stops with
`errors=ledger-not-private` when it is not.

## Shape

```json
{
  "version": 1,
  "companies": {
    "example.com": { "name": "Example Inc", "website": "https://example.com", "score": 82, "tier": "hot", "fields": {} }
  },
  "people": {
    "lead:example.com": [
      { "email_sha1_12": "3f2a…", "email": "sam@example.com", "name": "Sam Example", "title": "Head of Platform", "opt_out": false }
    ]
  },
  "deals": [
    { "id": "D-1", "company": "example.com", "name": "Example Inc: platform", "stage": "discovery", "owner": "<person>", "amount": null, "close_date": null, "last_activity": "2026-01-01" }
  ],
  "notes": [
    { "key": "lead:example.com", "at": "2026-01-01T00:00:00Z", "body": "[sales-loop] researched\n…\nsales-key: lead:example.com" }
  ],
  "tasks": [
    { "key": "lead:example.com", "title": "Call back about pricing", "due": "2026-01-03", "owner": "<person>", "done": false }
  ]
}
```

The values above are synthetic. A person edits the file to set a stage, an
owner or `opt_out: true`.

## Write protocol: one commit per operation

```sh
W=/tmp/sales/ledger && B=<branch> && F=<path>
[ -d $W/.git ] || gh repo clone <owner>/<repo> $W -- --single-branch --branch $B --depth 1
git -C $W fetch -q origin $B && git -C $W reset -q --hard origin/$B
# change $W/$F with jq into a temp file, then move it over $F
git -C $W commit -qam "sales: <operation> <key>" && git -C $W push -q origin HEAD:$B
```

A rejected push: fetch, reset, apply the change again, push. Three rejections:
end the run with `errors=ledger-busy`. Commit messages hold the key and the
operation only, never a name or an email.

## Operations

| Operation | Implementation |
|---|---|
| `record.context` | the visibility check, then the file parses and `version` is `1` |
| `company.find` / `company.upsert` | `.companies[<domain>]` |
| `person.find` / `person.upsert` | `.people[<key>][]` by `email_sha1_12` |
| `deal.list_open()` | `.deals[]` whose `stage` is not `won` or `lost` |
| `deal.create` / `deal.set_stage` | append to or change `.deals[]`; only under `record_writes: stages` |
| `note.add` / `note.list` | append to / filter `.notes[]` by `key` |
| `task.create` | append to `.tasks[]` |
| `field.set` | `.companies[<domain>].fields[<field>]` |
