#!/usr/bin/env bash
# Build the web app on this machine and upload the finished build to Vercel.
# Vercel only hosts the output: it runs no build, so the deploy bills no
# Build CPU Minutes. deploy-staging.yml and deploy-prod.yml both call this
# script, so a green staging deploy proves the prod path.
#
# usage: vercel-deploy-prebuilt.sh <preview|production> [--env K=V]... [--build-env K=V]...
#   --env K=V        runtime value of this one deployment (`vercel deploy --env`)
#   --build-env K=V  build-time value. It wins over the project's Vercel value,
#                    because `next build` inlines NEXT_PUBLIC_* and bakes the
#                    public runtime config into prerendered pages.
#
# Needs VERCEL_TOKEN, VERCEL_ORG_ID and VERCEL_PROJECT_ID. Run it from the
# repository root. The deployment URL is the last line on stdout; the CLI logs
# go to stderr.
set -euo pipefail

target="${1:-}"
case "$target" in
  preview) prod=() ;;
  production) prod=(--prod) ;;
  *) echo "usage: $0 <preview|production> [--env K=V]... [--build-env K=V]..." >&2; exit 2 ;;
esac
shift

runtime_flags=()
build_values=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --env) runtime_flags+=(--env "${2:?--env needs K=V}"); shift 2 ;;
    --build-env) build_values+=("${2:?--build-env needs K=V}"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"

# Pinned so the CLI that builds is the CLI that uploads. A custom deploymentId
# (Skew Protection on a prebuilt deploy) needs vercel > 50.3.3.
read -r -a cli <<<"${VERCEL_CLI:-npx --yes vercel@65.14.0}"
vercel() { "${cli[@]}" "$@"; }

# 1. Project settings and the target's environment variables.
vercel pull --yes --environment="$target" --token="$VERCEL_TOKEN" >&2
env_file=".vercel/.env.${target}.local"
test -f "$env_file" || { echo "::error::vercel pull wrote no $env_file" >&2; exit 1; }

# `vercel pull` cannot read a Sensitive variable and writes KEY="[SENSITIVE]".
# Drop those lines: the build sees the key unset instead of inlining the
# placeholder. The deployment still gets the real value at runtime.
placeholder='^[A-Za-z_][A-Za-z0-9_]*="\[SENSITIVE\]"$'
if grep -qE "$placeholder" "$env_file"; then
  echo "Sensitive values the build does not get (the runtime does): $(grep -E "$placeholder" "$env_file" | cut -d= -f1 | paste -sd, -)" >&2
  grep -vE "$placeholder" "$env_file" >"${env_file}.tmp" || true
  mv "${env_file}.tmp" "$env_file"
fi

# 2. Build values win over the pulled project values. Vercel does not document
# which side wins when a key is in both the shell and $env_file, so the value
# goes into both.
for kv in ${build_values[@]+"${build_values[@]}"}; do
  key="${kv%%=*}"
  value="${kv#*=}"
  if [ "$key" = "$kv" ] || ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "::error::--build-env needs KEY=VALUE, got '${key}'" >&2; exit 2
  fi
  case "$value" in
    *'"'* | *$'\n'* | *'\'*) echo "::error::--build-env ${key}: quotes, backslashes and newlines are not supported" >&2; exit 2 ;;
  esac
  grep -v "^${key}=" "$env_file" >"${env_file}.tmp" || true
  mv "${env_file}.tmp" "$env_file"
  printf '%s="%s"\n' "$key" "$value" >>"$env_file"
  export "${key}=${value}"
done

# 3. What a build on Vercel gets from the platform and a local build does not.
# VERCEL=1: the root layout bakes the runtime config so marketing pages
# prerender (apps/web/src/lib/runtime-config-mode.ts), and next.config.ts skips
# the standalone output. KORTIX_VERCEL_DEPLOYMENT_ID: next.config.ts sets it as
# Next's deploymentId, which Skew Protection needs on a prebuilt deploy. Vercel
# refuses an ID that the project already used, so the run and the attempt are
# part of it (at most 32 characters, never starting with dpl_).
export VERCEL=1
# The two flags Vercel's own build machines set. NEXT_ENABLE_ADAPTER: @vercel/next
# builds through the Next adapter, as on Vercel (without it the log says
# "Adapter none" and the output takes the older path). VERCEL_IMMUTABLE_STATIC_FILES_ENABLED:
# scripts go to /_next/static/immutable/, which Vercel serves from a store shared
# by every deployment of the project. A script that did not change keeps its URL,
# so browser and CDN caches survive a deploy and a tab still on the old release
# loads its chunks. Without it every script URL carries ?dpl=<id> and changes
# on every deploy.
export NEXT_ENABLE_ADAPTER=1
export VERCEL_IMMUTABLE_STATIC_FILES_ENABLED=1
sha="$(git rev-parse HEAD)"
export KORTIX_VERCEL_DEPLOYMENT_ID="k${sha:0:12}-${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-1}"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=6144}"
echo "Building ${target} on this machine, deploymentId ${KORTIX_VERCEL_DEPLOYMENT_ID}" >&2

vercel build ${prod[@]+"${prod[@]}"} --yes --token="$VERCEL_TOKEN" >&2

# 4. Upload the output. --archive=tgz: Vercel refuses more than 15,000 files.
vercel deploy --prebuilt --archive=tgz --yes ${prod[@]+"${prod[@]}"} --token="$VERCEL_TOKEN" \
  ${runtime_flags[@]+"${runtime_flags[@]}"} | tail -n1
