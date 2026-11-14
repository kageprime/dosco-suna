# Record: Greenhouse

`record.kind: greenhouse`, `record.target: <company name>` (for links only).

## Access, first match wins

1. The `greenhouse` connector: `kortix connectors show greenhouse` once per
   session, then `kortix connectors call greenhouse <tool> '<json>' --json`.
2. The secrets `GREENHOUSE_API_KEY` and `GREENHOUSE_USER_ID`: the Harvest API
   at `https://harvest.greenhouse.io/v1`, Basic auth with the API key as the
   username and an empty password (`curl -u "$GREENHOUSE_API_KEY:"`). Every
   write sends the header `On-Behalf-Of: $GREENHOUSE_USER_ID`: the Greenhouse
   user the note is written as (a dedicated user, never a person's own
   account when the team has one).

Greenhouse has announced changes to its Harvest API versions. Read
Greenhouse's developer documentation (`https://developers.greenhouse.io`)
once at setup and once when a call below answers `404` or `410`; follow the
current version's paths and record the version in `record.fields.api_version`.

Lists are paged with the `Link` header (`per_page` up to 500). Write every
list into a file.

## Operations

| Operation | Harvest call |
|---|---|
| `record.context` | `GET /users/<GREENHOUSE_USER_ID>`, then `GET /jobs?status=open` |
| `job.list()` | `GET /jobs?status=open` |
| `candidate.find(email)` | `GET /candidates?email=<email>` |
| `candidate.create` | never: the ATS owns candidate creation. A webhook candidate that is not in Greenhouse gets a Review `decision` asking a person to add them |
| `application.list(since)` | `GET /applications?created_after=<ISO time>&status=active`; for changes, `last_activity_after=<ISO time>` |
| `application.get(id)` | `GET /applications/<id>`, then `GET /candidates/<candidate_id>` for the attachments (the resume URL is short-lived: download it once into `/tmp/recruiting/`) |
| `note.add(record, body)` | `POST /candidates/<id>/activity_feed/notes` with `{"user_id":<GREENHOUSE_USER_ID>,"body":"<body>","visibility":"private"}` and the `On-Behalf-Of` header |
| `note.list(record)` | `GET /candidates/<id>/activity_feed`, the `notes` array |
| `record.erase` | none: retention goes to a person (contract §8) |

## Notes

- Never call a reject, advance, move, hire or anonymize endpoint. A person does that in Greenhouse.
- Scorecards in Greenhouse belong to interviewers. The loop writes its screen as a private note, never as a scorecard.
- The `recruiting-applicant` trigger accepts only `Authorization: Bearer <RECRUITING_WEBHOOK_SECRET>`. Use the `recruiting-ats-poll` trigger with Greenhouse, unless its webhook settings let a person set that header, or a relay in front of it adds the header.
