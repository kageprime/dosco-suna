# Record: HubSpot

`record.kind: hubspot`, `record.target: <portal id>` (for links only).
`record.objects`: `contacts`, `companies`, `deals`. Custom properties the loop
writes, created once at setup: `kortix_lead_key` (single-line text),
`kortix_score` (number), `kortix_tier` (dropdown: hot, warm, cold,
disqualified) on contacts and companies.

## Access, first match wins

1. The `hubspot` connector: `kortix connectors show hubspot` once per session,
   then `kortix connectors call hubspot <tool> '<json>' --json`.
2. The secret `HUBSPOT_ACCESS_TOKEN` (a private app token with the CRM
   object read and write scopes): `https://api.hubapi.com`, header
   `Authorization: Bearer $HUBSPOT_ACCESS_TOKEN`.

## Operations

| Operation | CRM v3 call |
|---|---|
| `record.context` | `GET /crm/v3/properties/contacts` and `/crm/v3/properties/companies`: the three `kortix_*` properties exist |
| `company.find(domain)` | `POST /crm/v3/objects/companies/search` with a filter `domain EQ <domain>`, `limit: 1` |
| `company.upsert` | none found: `POST /crm/v3/objects/companies` with `{"properties":{"domain":"<domain>", …}}`; found: `PATCH /crm/v3/objects/companies/<id>` with the empty fields only |
| `person.find(email)` | `POST /crm/v3/objects/contacts/search` with a filter `email EQ <email>` |
| `person.upsert` | `POST /crm/v3/objects/contacts` or `PATCH /crm/v3/objects/contacts/<id>`; associate it with the company (`PUT /crm/v4/objects/contacts/<id>/associations/default/companies/<company id>`) |
| `deal.list_open()` | `POST /crm/v3/objects/deals/search` excluding the closed stages of each pipeline (`GET /crm/v3/pipelines/deals` lists them); properties `dealname,dealstage,amount,closedate,hubspot_owner_id,notes_last_updated` |
| `deal.create` / `deal.set_stage` | `POST /crm/v3/objects/deals` / `PATCH /crm/v3/objects/deals/<id>` with `dealstage`; only under `record_writes: stages` |
| `note.add(record, body)` | `POST /crm/v3/objects/notes` with `hs_note_body`, `hs_timestamp` and an association to the record |
| `note.list(record)` | `GET /crm/v4/objects/<object>/<id>/associations/notes`, then a batch read of the notes |
| `task.create` | `POST /crm/v3/objects/tasks` with `hs_task_subject`, `hs_timestamp` (due), `hubspot_owner_id` and an association |
| `field.set` | `PATCH /crm/v3/objects/<object>/<id>` with the one property |

## Notes

- Search answers at most 100 results a page and is rate limited per second; page into a file.
- Opt-out: the contact's subscription status or the property sales.json names in `record.fields.do_not_contact`.
- HubSpot sends marketing email itself; the loop never enrolls a contact in a sequence or a workflow.
