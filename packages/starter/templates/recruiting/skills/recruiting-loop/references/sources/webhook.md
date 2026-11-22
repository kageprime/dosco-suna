# Source: the recruiting webhook (applications and referrals)

Triggers `recruiting-applicant` (`body.kind: application`) and
`recruiting-referral` (`body.kind: referral`). Both share one webhook secret,
`RECRUITING_WEBHOOK_SECRET`. Every request carries the header
`Authorization: Bearer <RECRUITING_WEBHOOK_SECRET>`. A request without it never
starts a run.

Callers: the careers form's backend, the referral form's backend, or a relay
in front of an ATS whose own webhooks cannot send that header. The URL is
`kortix triggers info recruiting-applicant --json` → `webhook_url`; the
referral trigger has its own URL (`kortix triggers info recruiting-referral --json`).

## Payload contract

The caller sends JSON. Only `kind`, `role` and `candidate.email` are required.
Any other field is optional; an unknown field is ignored.

An application (synthetic values):

```json
{
  "kind": "application",
  "role": "example-role",
  "ats": { "system": "ashby", "application_id": null, "candidate_id": null },
  "candidate": {
    "name": "Sam Example",
    "email": "sam@example.com",
    "profile_url": "https://example.com/sam",
    "resume_text": "Backend engineer. Built and ran a payments service in production for 3 years…",
    "resume_url": null
  },
  "answers": [
    { "id": "work-authorization", "text": "Yes, no sponsorship needed" }
  ],
  "submitted_at": "2026-01-01T09:00:00Z"
}
```

A referral (synthetic values):

```json
{
  "kind": "referral",
  "role": "example-role",
  "referrer": { "name": "Alex Example", "email": "alex@example.com" },
  "candidate": { "name": "Sam Example", "email": "sam@example.com", "profile_url": "https://example.com/sam" },
  "reason": "Worked together for two years; Sam ran our on-call rotation.",
  "submitted_at": "2026-01-01T09:00:00Z"
}
```

`role` is a `roles[].id` in recruiting.json, or the ATS job id in
`roles[].ats_job_id`.

## Run

1. Validate the payload: `kind`, `role` and `candidate.email` present. Missing:
   end with `errors=bad-payload`; write nothing.
2. Compute the key (contract §3). Run contract §5 from step 1.
3. **Application.** Read the CV from `resume_text`, or download `resume_url`
   once into `/tmp/recruiting/` and extract the text (`pdftotext` for a PDF).
   When `ats.application_id` is set and `record.kind` is that ATS, read the
   application with `application.get` and use the ATS's copy. Not in the
   ATS and `record.kind` is an ATS: screen, write nothing to the ATS, and
   put the scorecard into the Review `decision` item with the request to add
   the candidate.
4. **Referral.** Add a `[recruiting-loop] referral` note with the referrer's
   reason, paraphrased, and the referrer's name (the referrer is a colleague,
   not the candidate). A referral without a CV: no screen. Submit a Review
   `decision` asking a person whether to reach out; on `advance`, the
   decisions pass drafts the first message (`recruiting-candidate-updates`,
   kind `referral-intro`). A referral never raises a score.
5. Delete the files under `/tmp/recruiting/`.
6. End with the run line (contract §10).
