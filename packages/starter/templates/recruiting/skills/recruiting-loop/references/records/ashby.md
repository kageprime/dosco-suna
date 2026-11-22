# Record: Ashby

`record.kind: ashby`, `record.target: <organization name>` (for links only).

## Access, first match wins

1. The `ashby` connector: `kortix connectors show ashby` once per session for
   the tool names and argument shapes, then
   `kortix connectors call ashby <tool> '<json>' --json`.
2. The secret `ASHBY_API_KEY`: every call is `POST https://api.ashbyhq.com/<method>`
   with a JSON body, Basic auth with the API key as the username and an empty
   password (`curl -u "$ASHBY_API_KEY:"`), `Content-Type: application/json`.
   The key needs read access to candidates, applications and jobs, and write
   access to candidate notes only.

Every response has `success`. `success: false` is a failure even with HTTP
200: read `errors`. Read Ashby's API reference (`https://developers.ashbyhq.com`)
once when a call below answers an error: method and field names change
between API versions.

## Operations

| Operation | Ashby method |
|---|---|
| `record.context` | `apiKey.info`, then `job.list` |
| `job.list()` | `job.list` with `{"status":["Open"]}`; map each to `roles[].ats_job_id` |
| `candidate.find(email)` | `candidate.search` with `{"email":"<email>"}` |
| `candidate.create` | never: the ATS owns candidate creation. A webhook candidate that is not in Ashby gets a Review `decision` asking a person to add them |
| `application.list(since)` | `application.list` with `{"createdAfter":<epoch ms>}`, paged with `cursor` into a file; keep `status: Active` |
| `application.get(id)` | `application.info` with `{"applicationId":"<id>"}`; then `candidate.info` for the candidate and its resume file handle |
| `note.add(record, body)` | `candidate.createNote` with `{"candidateId":"<id>","note":"<body>"}` |
| `note.list(record)` | `candidate.listNotes` with `{"candidateId":"<id>"}` |
| `record.erase` | none: retention goes to a person (contract §8) |

## Notes

- Never call `application.change_stage`, `application.changeStage`, `candidate.anonymize` or any method that archives, rejects or moves a candidate. A person does that in Ashby.
- The `recruiting-applicant` trigger accepts only `Authorization: Bearer <RECRUITING_WEBHOOK_SECRET>`. Use the `recruiting-ats-poll` trigger with Ashby, unless its webhook settings let a person set that header, or a relay in front of it adds the header.
