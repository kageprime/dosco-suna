#!/usr/bin/env bash
# Test the prompt copied from this checkout's home page, end to end, by hand.
#
#   scripts/try-setup-prompt.sh <repository-folder> [--reset]
#
# Opens a shell in <repository-folder> where `kortix` is THIS checkout's CLI
# (not the released one) with a config file of its own, so the run never
# touches your real Kortix sign-in. git, gh and your coding agent keep their
# own logins. Start the stack first (`pnpm dev`, or `pnpm worktree start
# <slug>` in a worktree), copy the prompt from the home page, and paste it into
# `claude` or `codex` inside that shell. `--reset` forgets the test sign-in.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-}"
if [ -z "$TARGET" ] || [ ! -d "$TARGET" ]; then
  echo "usage: scripts/try-setup-prompt.sh <repository-folder> [--reset]" >&2
  exit 2
fi
TARGET="$(cd "$TARGET" && pwd)"

# The ports of this checkout: a worktree has a marker, the primary checkout uses the defaults.
WEB_PORT=3000
API_PORT=8008
if [ -f "$ROOT/.kortix-worktree.json" ]; then
  WEB_PORT="$(bun -e "console.log(require('$ROOT/.kortix-worktree.json').ports.web)")"
  API_PORT="$(bun -e "console.log(require('$ROOT/.kortix-worktree.json').ports.api)")"
fi

STATE="${XDG_CACHE_HOME:-$HOME/.cache}/kortix-try/$(basename "$ROOT")"
[ "${2:-}" = "--reset" ] && rm -rf "$STATE"
mkdir -p "$STATE/bin"
cat > "$STATE/bin/kortix" <<EOF
#!/bin/sh
KORTIX_CONFIG_FILE="$STATE/config.json" exec bun "$ROOT/apps/cli/src/index.ts" "\$@"
EOF
chmod +x "$STATE/bin/kortix"

for port in "$WEB_PORT" "$API_PORT"; do
  if ! curl -s -o /dev/null -m 3 "http://localhost:$port"; then
    echo "Nothing answers on localhost:$port. Start the stack first." >&2
    exit 1
  fi
done

cat <<EOF

  kortix in this shell   $ROOT/apps/cli (config: $STATE/config.json)
  home page              http://localhost:$WEB_PORT   (copy the prompt here)
  repository             $TARGET

  1. Open the home page, choose Developer, copy the prompt.
  2. Run \`claude\` or \`codex\` here and paste it.
  3. \`exit\` leaves this shell. Your own kortix sign-in is untouched.

EOF
cd "$TARGET"
PATH="$STATE/bin:$PATH" KORTIX_TRY=1 exec "${SHELL:-bash}"
