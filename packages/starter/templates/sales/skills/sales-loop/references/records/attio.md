# Record: Attio

`record.kind: attio`, `record.target: <workspace slug>` (for links only).
`record.objects`: `people`, `companies`, `deals` (Attio's standard objects).
Custom attributes the loop writes, created once at setup (`references/analysis.md`):
`kortix_lead_key` (text), `kortix_score` (number), `kortix_tier` (select:
hot, warm, cold, disqualified) on `people` and `companies`.

## Access, first match wins

1. The `attio` connector: `kortix connectors show attio` once per session for
   the tool names and argument shapes, then
   `kortix connectors call attio <tool> '<json>' --json`.
2. The secret `ATTIO_API_KEY`: REST v2 at `https://api.attio.com/v2`, header
   `Authorization: Bearer $ATTIO_API_KEY`, `Content-Type: application/json`.

Read Attio's API reference (`https://docs.attio.com`) once when a call below
answers `400`: Attio validates every attribute value against its type.

## Operations

| Operation | REST v2 call |
|---|---|
| `record.context` | `GET /v2/self` (the token's workspace and scopes), then `GET /v2/objects/people/attributes` and `.../companies/attributes`: the three `kortix_*` attributes exist |
| `company.find(domain)` | `POST /v2/objects/companies/records/query` with `{"filter":{"domains":{"domain":{"$eq":"<domain>"}}},"limit":1}` |
| `company.upsert(domain, fields)` | `PUT /v2/objects/companies/records?matching_attribute=domains` with `{"data":{"values":{"domains":[{"domain":"<domain>"}], …}}}`; send only fields that are empty on the found record |
| `person.find(email)` | `POST /v2/objects/people/records/query` with `{"filter":{"email_addresses":"<email>"},"limit":1}` |
| `person.upsert(email, fields)` | `PUT /v2/objects/people/records?matching_attribute=email_addresses` with `email_addresses` and the company reference |
| `deal.list_open()` | `POST /v2/objects/deals/records/query` with a filter on the stage attribute that excludes the won and lost stages; page with `limit` and `offset` into a file |
| `deal.create` / `deal.set_stage` | `POST /v2/objects/deals/records` / `PATCH /v2/objects/deals/records/<record_id>`; only under `record_writes: stages` |
| `note.add(record, body)` | `POST /v2/notes` with `{"data":{"parent_object":"<object>","parent_record_id":"<id>","title":"<marker line>","format":"markdown","content":"<body>"}}` |
| `note.list(record)` | `GET /v2/notes?parent_object=<object>&parent_record_id=<id>` |
| `task.create` | `POST /v2/tasks` with `content`, `deadline_at`, `linked_records`, `assignees` |
| `field.set` | `PATCH /v2/objects/<object>/records/<record_id>` with the one value |

## Notes

- A record link for a Review item: `https://app.attio.com/<record.target>/<object>/<record_id>` when `record.target` is set; otherwise the record id.
- Attio keeps several values for `domains` and `email_addresses`. Match on any of them.
- Opt-out: a person whose notes hold `[sales-loop] skipped · opt-out`, or whose list entry or attribute the team uses for do-not-contact is set (sales.json `record.fields.do_not_contact`).
