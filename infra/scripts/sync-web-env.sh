#!/usr/bin/env bash

set -euo pipefail

# Only dev runs the frontend on ECS. Staging and prod serve it from Vercel,
# whose deploy jobs never read a web secret blob.
ENVIRONMENT="${1:?environment required: dev}"
case "$ENVIRONMENT" in
  dev)
    # infra/terraform/environments/dev-web-us-east-2 reads this secret.
    AWS_REGION="us-east-2"
    SECRET_NAME="kortix-dev-use2-web-env"
    ;;
  *)
    echo "unknown environment: $ENVIRONMENT" >&2
    exit 2
    ;;
esac

# shellcheck source=infra/scripts/lib/aws-secret.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/aws-secret.sh"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PAYLOAD="$(node "$REPO_ROOT/infra/scripts/render-web-env.mjs" "$ENVIRONMENT")"
KEY_COUNT="$(printf '%s' "$PAYLOAD" | jq 'keys | length')"

printf '%s' "$PAYLOAD" | put_or_create_secret "$AWS_REGION" "$SECRET_NAME" "Kortix ${ENVIRONMENT} web runtime environment" >/dev/null

unset PAYLOAD
echo "Synced $KEY_COUNT allowlisted values to $SECRET_NAME in $AWS_REGION."
