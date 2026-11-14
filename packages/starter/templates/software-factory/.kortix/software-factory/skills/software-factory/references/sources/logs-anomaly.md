# Source: production log anomalies

Trigger `source-logs-anomaly` (cron, hourly at :20, at most 24 runs a day).
Disabled by default. Setting: `sources.logs-anomaly.backends`, a list of
`{ "kind": "<clickhouse|betterstack|datadog|loki|cloudwatch|elastic>", "table_or_index": "<name>", "secret": "<secret name>" }`,
and `baseline_days` (default 7). Read-only, always. The database itself is
`db-observer.md`.

| | |
|---|---|
| Signal | the last hour of application logs against the same hour on each baseline day |
| Finding | a new error log pattern, an error pattern that spiked, a route whose 5xx rate rose, a route whose p95 latency rose |
| Bar | a code anchor (a normalized message you can `git grep`, a route handler) **and** impact: a new pattern with ≥ 3 error lines and none in the baseline; or ≥ 20 lines and ≥ 3× the baseline hourly rate; or ≥ 5 5xx and ≥ 3× the baseline 5xx rate; or p95 ≥ 2× the baseline and ≥ +500 ms with ≥ 30 requests in each of the last two hours. No anchor: one line in the `logs:ledger` digest |
| Key | `logs:<backend>:<sha1-12 of normalized message + route>` (5xx: `http-5xx\|<METHOD> <route>`; latency: `p95\|<METHOD> <route>`) |
| Signal value | `signal: lines_1h=<n> baseline_per_h=<x>` · `signal: http_5xx_1h=<n> requests_1h=<n> baseline_per_h=<x>` · `signal: p95_ms=<n> baseline_p95_ms=<n>` |
| Priority | 1 a 5xx class on sign-in, payment or writes, or ≥ 100 5xx in the hour; 2 other 5xx or error spikes; 3 latency; 4 warnings |
| Label | `source:logs` |
| Kind | `bug` (errors), `task` (latency) |
| Credentials | a read-only logs credential per backend; never a write key |
| Cap | contract hard rule 5 (5 new tickets a day) |

## Normalize first

Replace in every message: numbers → `<n>`, UUIDs and hex ids of 16+
characters → `<id>`, emails → `<email>`, IPs → `<ip>`, URLs → `<url>`, quoted
strings → `<s>`. Route segments with a digit, an `@` or 20+ characters →
`:id`. The normalized text is the fingerprint. Never keep the raw line.

## Backends

| Backend | Read with | Current hour vs. baseline |
|---|---|---|
| ClickHouse, Better Stack Telemetry (ClickHouse over HTTP) | `curl -sf --config - "$CLICKHOUSE_URL" --data-binary @q.sql` with the user and password in a curl config on stdin, a read-only user | `select route, count() as requests, countIf(status >= 500) as e5xx, quantile(0.95)(duration_ms) as p95 from <table> where ts > now() - interval 1 hour group by route order by e5xx desc limit 100`; the same per baseline day over `ts between now() - interval <d> day - interval 1 hour and now() - interval <d> day`; errors: `select <normalize(message)> as fp, route, count() from <table> where level in ('error','fatal') and ts > now() - interval 1 hour group by fp, route order by count() desc limit 200` |
| Datadog | Logs Aggregate API, `POST https://api.datadoghq.com/api/v2/logs/analytics/aggregate` with `DD_API_KEY` + `DD_APP_KEY` (logs_read_data) | `status:error` grouped by `@http.url_details.path` and the message pattern, `from: now-1h` and each baseline window |
| Grafana Loki | `GET <loki>/loki/api/v1/query_range` | `sum by (route) (count_over_time({app="<app>"} \|= "error" [1h]))` now and `offset <d>d` |
| CloudWatch Logs | `aws logs start-query` with a read-only role | `stats count(*) by bin(1h), route \| filter level = "error"` over each window |
| Elastic | `POST <index>/_search` with `size: 0` and terms aggregations | the same two windows |
| Application logs in the sandbox | the `dev-environment` skill | not a production signal; never a source |

Every query reads aggregates. Never select a user column, a request body or a
payload field.

## Run

1. Read factory.json. For each backend, run the current-hour and baseline
   queries into files under `/tmp/factory/logs/`. A backend that fails: name
   it in `errors=`, continue with the others. Each query has a 60 s timeout;
   on a 429 wait the `Retry-After` once.
2. Normalize, group by fingerprint and route, compute the ratios in code
   (`jq` or `bun`), keep the rows above the bar.
3. Anchor each row: `git grep -n` the message class or the route in the
   repository at the trunk. No anchor: digest line.
4. Cluster rows with one cause (an error pattern and the 5xx rise on its
   route) into one finding; the strongest row decides the key. A slow query
   behind a latency rise is `db-observer.md`'s finding: name its key as
   `related:`.
5. Upsert (contract §5): `## Evidence` holds the normalized fingerprint, the
   counts and the baseline, the time window, the anchor `file:line`.
   `## Proposed change`: the root cause you read at the anchor.
   `## Acceptance`: a test that reproduces the error class on synthetic data,
   or a measured latency on the dev environment before and after.
6. One `[factory-source] update · digest` comment on `logs:ledger` with the
   rows below the bar, only when there are any.
7. End with `source-logs-anomaly:`, the contract run line, `rows=<n>
   anchored=<n> clusters=<n>`.
