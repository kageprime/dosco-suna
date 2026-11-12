#!/usr/bin/env bash
# Retire stale web hostnames from the kortix.com Cloudflare zone (KRTX-3365).
#
# new.kortix.com and prod-test.kortix.com are retired Vercel-era hosts: their
# zone records still CNAME to Vercel's vanity DNS target, but no Vercel
# project claims the domains any more, so Vercel serves its cached Let's
# Encrypt certificate until it expires and never renews it. Removing the
# record stops the name resolving and takes the broken surface down.
#
# Guard: a host is deleted ONLY when every record it holds is a CNAME whose
# content ends with .vercel-dns-016.com (the stale Vercel target). Any other
# record (a re-pointed CNAME, an A or TXT record) refuses that host loudly,
# so a run can never delete a record a live deployment still uses.
#
# Usage: retire-stale-web-hosts.sh <fqdn> [<fqdn>...]
# Requires: CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN. Idempotent: a host with
# no records left counts as already retired and succeeds.
set -euo pipefail

if [ $# -eq 0 ]; then
  echo "usage: $0 <fqdn> [<fqdn>...]" >&2
  exit 2
fi
: "${CLOUDFLARE_ZONE_ID:?CLOUDFLARE_ZONE_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
API_URL="https://api.cloudflare.com/client/v4"
STALE_VERCEL_TARGET_SUFFIX=".vercel-dns-016.com"

list_records() { # $1 = fqdn
  curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$API_URL/zones/$CLOUDFLARE_ZONE_ID/dns_records?name=$1&per_page=100"
}

delete_record() { # $1 = record id
  curl --fail-with-body --silent --show-error --request DELETE \
    --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "$API_URL/zones/$CLOUDFLARE_ZONE_ID/dns_records/$1" >/dev/null
}

status=0
for host in "$@"; do
  response="$(list_records "$host")"
  if ! jq -e '.success == true' >/dev/null <<<"$response"; then
    echo "::error::$host: the Cloudflare list call failed" >&2
    status=1
    continue
  fi
  count="$(jq '.result | length' <<<"$response")"
  if [ "$count" -eq 0 ]; then
    echo "$host: no zone records left — already retired"
    continue
  fi
  if ! jq -e --arg suffix "$STALE_VERCEL_TARGET_SUFFIX" \
    'all(.result[]; .type == "CNAME" and (.content | endswith($suffix)))' <<<"$response" >/dev/null; then
    echo "::error::$host: refused — the zone holds a record that is not a CNAME to the stale Vercel target; inspect it by hand" >&2
    status=1
    continue
  fi
  ids="$(jq -r '.result[].id' <<<"$response")"
  for id in $ids; do
    echo "$host: deleting record $id"
    delete_record "$id"
  done
  after="$(list_records "$host")"
  remaining="$(jq '.result | length' <<<"$after")"
  if [ "$remaining" -ne 0 ]; then
    echo "::error::$host: still holds $remaining record(s) after the delete calls" >&2
    status=1
  else
    echo "$host: retired — the name stops resolving once DNS propagates"
  fi
done
exit "$status"
