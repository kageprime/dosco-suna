#!/bin/bash
# The workspace has a support agent to measure.
cat > /tmp/agent.json <<'JSON'
{"behavior": {"description": "Answers customer support emails.", "prompt": "You answer customer support emails for a bakery's online shop: friendly, short, and correct about our refund policy (full refund within 14 days of delivery, no questions asked)."}}
JSON
kortix agents config support-replies --file /tmp/agent.json
