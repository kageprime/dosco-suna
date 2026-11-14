# Record: Workable

`record.kind: workable`, `record.target: <subdomain>` (the `WORKABLE_SUBDOMAIN`).

## Access, first match wins

1. The `workable` connector: `kortix connectors show workable` once per
   session, then `kortix connectors call workable <tool> '<json>' --json`.
2. The secrets `WORKABLE_API_TOKEN` and `WORKABLE_SUBDOMAIN`:
   `https://$WORKABLE_SUBDOMAIN.workable.com/spi/v3`, header
   `Authorization: Bearer $WORKABLE_API_TOKEN`. The token needs the read
   scopes for jobs and candidates and the write scope for comments only.

Lists answer a `paging.next` URL: follow it into a file. Workable rate
limits each token: on `429`, wait for the `X-Rate-Limit-Reset` time, then
retry once. Read Workable's API reference (`https://workable.readme.io`) once
when a call below answers an error.

## Operations

| Operation | API call |
|---|---|
| `record.context` | `GET /jobs?state=published&limit=1` answers `200` |
| `job.list()` | `GET /jobs?state=published`; map each `shortcode` to `roles[].ats_job_id` |
| `candidate.find(email)` | `GET /candidates?email=<email>` |
| `candidate.create` | never: the ATS owns candidate creation. A webhook candidate that is not in Workable gets a Review `decision` asking a person to add them |
| `application.list(since)` | `GET /candidates?created_after=<ISO time>`; for changes, `updated_after=<ISO time>`; keep `disqualified: false` |
| `application.get(id)` | `GET /candidates/<id>`: the job, the stage, the answers and the resume URL |
| `note.add(record, body)` | `POST /candidates/<id>/comments` with `{"member_id":"<member id>","comment":{"body":"<body>"}}`; the member id is the dedicated member in `record.fields.member_id` |
| `note.list(record)` | `GET /candidates/<id>/activities`, the comment entries |
| `record.erase` | none: retention goes to a person (contract §8) |

## Notes

- Never call `POST /candidates/<id>/move`, `/disqualify` or any endpoint that moves, disqualifies or hires. A person does that in Workable.
- The `recruiting-applicant` trigger accepts only `Authorization: Bearer <RECRUITING_WEBHOOK_SECRET>`. Use the `recruiting-ats-poll` trigger with Workable, unless its webhook settings let a person set that header, or a relay in front of it adds the header.
