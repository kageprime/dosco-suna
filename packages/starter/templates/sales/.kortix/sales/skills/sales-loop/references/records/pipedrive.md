# Record: Pipedrive

`record.kind: pipedrive`, `record.target: <company subdomain>`.
`record.objects`: `persons`, `organizations`, `deals`. Custom fields the loop
writes, created once at setup: `Kortix lead key` (text), `Kortix score`
(numerical), `Kortix tier` (single option: hot, warm, cold, disqualified) on
persons and organizations. Pipedrive addresses a custom field by its hash key:
read the keys once (`GET /v1/personFields`, `/v1/organizationFields`) and
write them into sales.json `record.fields`.

## Access, first match wins

1. The `pipedrive` connector: `kortix connectors show pipedrive` once per
   session, then `kortix connectors call pipedrive <tool> '<json>' --json`.
2. The secret `PIPEDRIVE_API_TOKEN`: `https://<record.target>.pipedrive.com/api/v1`,
   header `x-api-token: $PIPEDRIVE_API_TOKEN`. Never put the token in a URL
   that is logged.

## Operations

| Operation | API call |
|---|---|
| `record.context` | `GET /users/me`, then the field keys above exist in sales.json |
| `company.find(domain)` | `GET /organizations/search?term=<domain>&fields=custom_fields,name`; keep an exact match on the website or the domain |
| `company.upsert` | `POST /organizations` or `PUT /organizations/<id>` with the empty fields only |
| `person.find(email)` | `GET /persons/search?term=<email>&fields=email&exact_match=true` |
| `person.upsert` | `POST /persons` (`name`, `email`, `org_id`) or `PUT /persons/<id>` |
| `deal.list_open()` | `GET /deals?status=open&limit=500`, paged with `start`, into a file |
| `deal.create` / `deal.set_stage` | `POST /deals` / `PUT /deals/<id>` with `stage_id`; only under `record_writes: stages` |
| `note.add(record, body)` | `POST /notes` with `content` and one of `person_id`, `org_id`, `deal_id` |
| `note.list(record)` | `GET /notes?person_id=<id>` (or `org_id`, `deal_id`), `sort=add_time DESC` |
| `task.create` | `POST /activities` with `subject`, `type: task`, `due_date`, `user_id` and the record id |
| `field.set` | `PUT /persons/<id>` (or `organizations`) with the one field hash key |

## Notes

- `update_time` and `last_activity_date` on a deal drive `sales-deal-hygiene`.
- Opt-out: the person's marketing status, or the field sales.json names in `record.fields.do_not_contact`.
