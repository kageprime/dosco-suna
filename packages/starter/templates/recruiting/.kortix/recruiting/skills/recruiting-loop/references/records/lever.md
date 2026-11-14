# Record: Lever

`record.kind: lever`, `record.target: <account name>` (for links only).
Lever calls a candidate in one hiring process an **opportunity**.

## Access, first match wins

1. The `lever` connector: `kortix connectors show lever` once per session,
   then `kortix connectors call lever <tool> '<json>' --json`.
2. The secret `LEVER_API_KEY`: `https://api.lever.co/v1`, Basic auth with the
   API key as the username and an empty password (`curl -u "$LEVER_API_KEY:"`).
   The key needs read access to opportunities and postings and write access
   to notes only.

Lists answer `data`, `hasNext` and `next`: page with `offset=<next>` into a
file. Read Lever's API reference (`https://hire.lever.co/developer/documentation`)
once when a call below answers an error.

## Operations

| Operation | API call |
|---|---|
| `record.context` | `GET /postings?state=published&limit=1` answers `200` |
| `job.list()` | `GET /postings?state=published`; map each id to `roles[].ats_job_id` |
| `candidate.find(email)` | `GET /opportunities?email=<email>` |
| `candidate.create` | never: the ATS owns candidate creation. A webhook candidate that is not in Lever gets a Review `decision` asking a person to add them |
| `application.list(since)` | `GET /opportunities?created_at_start=<epoch ms>&archived=false`; for changes, `updated_at_start=<epoch ms>` |
| `application.get(id)` | `GET /opportunities/<id>`, then `GET /opportunities/<id>/resumes` and `GET /opportunities/<id>/applications` for the answers |
| `note.add(record, body)` | `POST /opportunities/<id>/notes` with `{"value":"<body>"}` |
| `note.list(record)` | `GET /opportunities/<id>/notes` |
| `record.erase` | none: retention goes to a person (contract §8) |

## Notes

- Never call `PUT /opportunities/<id>/stage`, `PUT /opportunities/<id>/archived` or any endpoint that moves, archives or hires. A person does that in Lever.
- The `recruiting-applicant` trigger accepts only `Authorization: Bearer <RECRUITING_WEBHOOK_SECRET>`. Use the `recruiting-ats-poll` trigger with Lever, unless its webhook settings let a person set that header, or a relay in front of it adds the header.
