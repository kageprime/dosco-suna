#!/bin/bash
# correct: the reply holds 397.8 and no other number.
mkdir -p /logs/verifier
reply="$(cat /logs/agent/response.md 2>/dev/null)"
echo "reply: $reply"
numbers="$(printf '%s' "$reply" | tr -d ',' | grep -oE '[0-9]+(\.[0-9]+)?' | sort -u | tr '\n' ' ')"
echo "numbers found: $numbers"
correct=0; [ "$numbers" = "397.8 " ] && correct=1
echo "{\"correct\": $correct}" > /logs/verifier/reward.json
