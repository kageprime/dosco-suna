#!/bin/bash
mkdir -p /workspace
cat > /workspace/actions.json <<'JSON'
[
  {"owner": "Dana", "task": "Ship the pricing page copy", "due": "Friday"},
  {"owner": "Omar", "task": "Get the onboarding email reviewed", "due": "Wednesday"},
  {"owner": "Lee", "task": "Book the user interviews for next week", "due": null}
]
JSON
