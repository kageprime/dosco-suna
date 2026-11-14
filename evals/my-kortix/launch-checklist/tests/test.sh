#!/bin/bash
# format: 6-10 unchecked task-list items. useful + specific: judged.
mkdir -p /logs/verifier
f=/workspace/newsletter-launch.md
n=$(grep -cE '^\s*[-*] \[ \] ' "$f" 2>/dev/null || echo 0)
echo "task-list items: $n"
format=0; [ "$n" -ge 6 ] && [ "$n" -le 10 ] && format=1
echo "{\"format\": $format}" > /logs/verifier/reward.json
kortix evals judge \
  --criterion useful="Each item is a concrete step a person launching an email newsletter must do; no filler." \
  --criterion covers="The list covers deliverability (domain or sender setup), a signup path, the first issue, and a test send." \
  --input "$f" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
