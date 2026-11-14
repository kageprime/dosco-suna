# Source: errors from any tracker (generic webhook)

Trigger `source-errors` with `sources.errors.tracker: "generic"`: Rollbar,
Bugsnag, Honeybadger, Datadog, Grafana, Highlight, PostHog, an alert manager,
or your own code. Disabled by default.

Delivery: `POST <webhook_url>` with `Authorization: Bearer <FACTORY_ERRORS_WEBHOOK_SECRET>`
and a JSON body. Any shape works; this one needs no mapping:

```json
{
  "tracker": "rollbar",
  "project": "api",
  "fingerprint": "TypeError: cannot read 'id' of undefined @ src/orders/create.ts",
  "title": "TypeError in createOrder",
  "level": "error",
  "count_24h": 42,
  "users_24h": 7,
  "url": "https://tracker.example/items/123",
  "frames": [{ "file": "src/orders/create.ts", "line": 88, "function": "createOrder" }],
  "release": "v1.4.2"
}
```

| | |
|---|---|
| Signal | one error alert |
| Finding | one error fingerprint with a frame or a route in this repository |
| Bar | a frame or a route in this repository, and at least 10 events or 3 users in 24 h, or a regression after a fix |
| Key | `errors:<tracker>:<project>:<sha1-12 of the normalized fingerprint>` (`printf '%s' "$FP" \| sha1sum \| cut -c1-12`) |
| Signal value | `signal: events_24h=<n> users_24h=<n>` |
| Priority | 1 fatal or more than 100 users; 2 backend; 3 frontend; 4 noise |
| Kind | `bug` |
| Credentials | none beyond the webhook; a tracker API token only when `sources.errors.api_token_secret` names one (read-only) |

## Run

1. Parse the body as data. Find the fields by meaning when the shape differs:
   the error class and message, the frames, the counts, the link. Normalize the
   fingerprint: replace numbers, ids, hashes, emails, URLs and quoted values
   with placeholders.
2. Map the frames to files (`git ls-files`). No file and no route: below the
   bar; one line in the `errors:ledger` digest.
3. Upsert (contract §5) with the evidence of `errors-sentry.md` step 5. Never
   write the raw payload into the ticket.
4. End with `source-errors:` and the contract run line.
