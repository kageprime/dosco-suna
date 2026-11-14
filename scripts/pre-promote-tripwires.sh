#!/usr/bin/env bash
# The release suite's fast tripwires, run on this tree before a Promote dispatch.
#
#   bash scripts/pre-promote-tripwires.sh
#
# Each check is seconds long and is one the release suite fails on when a
# feature merged into dev without it: a registry the new code must join (CLI
# decisions, audit labels, the route manifest, flow ids), a generated file, a
# layering or source tripwire, a budget, an advisory. It runs every check, then
# names each red one and exits 1. Fix them on dev before the dispatch.
#
# The rule and its history: the learnings ledger, "Run the release suite's fast
# tripwires on dev HEAD before every Promote dispatch" (2026-10-21) and the
# v0.15.11 follow-up entry. The kortix-release skill, Step 2, runs this script.
#
# It needs `pnpm install` and the bun the repository pins. It starts no server
# and no database. The contract lanes still run only in the release suite.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

failed=()
check() {
  local name="$1"
  shift
  local log
  log="$(mktemp)"
  local start=$SECONDS
  if "$@" >"$log" 2>&1; then
    printf 'ok    %-34s %3ss\n' "$name" "$((SECONDS - start))"
  else
    printf 'FAIL  %-34s %3ss\n' "$name" "$((SECONDS - start))"
    tail -n 40 "$log" | sed 's/^/      /'
    failed+=("$name")
  fi
  rm -f "$log"
}

# API: registries every new route and CLI command joins, and source tripwires.
check "api tripwires" bash -c 'cd apps/api && bash scripts/test.sh \
  src/mcp/cli.test.ts \
  src/__tests__/unit-audit-route-labels.test.ts \
  src/__tests__/unit-routes-manifest.test.ts \
  src/__tests__/unit-request-primitives-tripwire.test.ts \
  src/__tests__/unit-catch-database-error-echo-guard.test.ts \
  src/__tests__/unit-mock-module-targets.test.ts \
  src/shared/sql-correlated-subquery-guard.test.ts'
check "api lint" pnpm --filter kortix-api lint

# Flows: one id per spec line, the deployed set, and route coverage.
check "flow registry (tests/unit)" pnpm --dir tests test:unit
check "route coverage" bun tests/bin/ke2e.ts coverage

# Web: generated files, i18n, the audit route registry, route handlers.
check "cli commands doc" bun apps/web/scripts/generate-cli-commands-doc.mjs --check
check "web i18n audit" bash -c 'cd apps/web && node --test scripts/audit-i18n.test.mjs'
check "web i18n catalogs" bash -c 'cd apps/web && node scripts/i18n-catalogs.mjs check'
check "web route registries" bash -c 'cd apps/web && bun test --isolate \
  src/components/iam/audit-display-helpers.test.ts \
  src/middleware-locale-routing.test.ts'

# Packages: exports, catalogs, layers, budgets, public surface.
check "ui exports" node packages/ui/scripts/gen-exports.mjs --check
check "ui i18n catalog" node packages/ui/scripts/gen-i18n-catalog.mjs --check
check "ui layers and stylesheet" bash -c 'cd packages/ui && bun test --isolate \
  src/module-cycles.test.ts \
  src/styles/stylesheet-coverage.test.ts'
check "starter skill budgets" bash -c 'cd packages/starter && bun test src/__tests__/managed-skills-drift.test.ts'
check "sdk public type surface" bash -c 'cd packages/sdk && bun test src/public-type-surface.test.ts'
check "kortixd boundaries" bash -c 'cd apps/kortix-sandbox-agent-server && bun test src/__tests__/architecture-boundaries.test.ts'

# Repository-wide.
check "learnings index" bash .agents/skills/learnings/scripts/index.sh --check
check "GHSA advisories (root lockfile)" node scripts/ghsa-audit.mjs

echo
if ((${#failed[@]})); then
  echo "${#failed[@]} tripwire(s) red: ${failed[*]}"
  exit 1
fi
echo "All tripwires green."
