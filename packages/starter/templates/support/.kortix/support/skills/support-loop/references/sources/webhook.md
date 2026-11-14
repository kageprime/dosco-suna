# Source: in-app feedback (webhook)

Trigger `support-feedback` (webhook, `SUPPORT_WEBHOOK_SECRET`, filter
`body.kind: feedback`). Enabled. It fires only after your product calls it.

## The payload your product sends

```sh
curl -sS -X POST "<webhook_url>" \
  -H "Authorization: Bearer $SUPPORT_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "kind": "feedback",
    "id": "fb_01",
    "text": "Export to CSV downloads an empty file.",
    "surface": "reports/export",
    "customer_ref": "<your internal customer id>",
    "plan": "team",
    "app_version": "2.4.1",
    "url": "https://app.example.com/reports",
    "rating": 2
  }'
```

`kind` and `text` are required. Every other field is optional. The values
above are synthetic. `kortix triggers info support-feedback --json` prints
`webhook_url`. Send `customer_ref`, never an email: the loop needs a stable
reference, not the identity. A webhook from a desk or a tool that cannot set
`Authorization: Bearer` does not use this trigger: use `support-queue`
(`queue-poll.md`).

## Run

1. Validate: no `text`, or `text` longer than 20,000 characters: end with
   `errors=bad-payload`. Never echo the payload into the run line.
2. Key (contract §3): `feedback:<id>`, else the sha1 form.
3. Store it as a conversation in the desk when the desk can hold one (the
   `json-file` desk: append it). A desk that cannot create conversations
   (Plain, Intercom, Zendesk, email) keeps feedback out of the customer
   queue: the triage note goes on a Review output instead, titled
   `Feedback: <category> · <key>`, with the paraphrased feedback, the surface
   and the plan in `--detail`. `support-feedback-clustering` reads these.
4. Run contract §5 steps 2 to 5. Feedback has no reply channel: the draft is
   part of the same Review output, for a person to follow up through your
   product. Nothing is sent.
5. End with `support-feedback:` and the contract run line.
