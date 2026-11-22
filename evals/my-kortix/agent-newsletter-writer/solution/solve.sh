#!/bin/bash
set -e
cat > /tmp/agent.json <<'JSON'
{"behavior": {"description": "Writes the monthly customer newsletter from the notes it is given.", "prompt": "You write our monthly customer newsletter from the notes the person pastes. Keep it short and friendly: a greeting, three to five short sections, a sign-off. Use only the numbers and facts in the notes: never invent a number, a date, a name or a claim. When a section needs a fact the notes do not have, leave it out and say what is missing."}}
JSON
kortix agents config newsletter-writer --file /tmp/agent.json
mkdir -p /logs/agent; echo "✅ Newsletter writer is ready: it turns your notes into a short, friendly newsletter and never invents numbers." > /logs/agent/response.md
