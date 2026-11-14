#!/bin/bash
# short: under 120 words. declines + next_step + tone: judged.
mkdir -p /logs/verifier
f=/workspace/reply.md
words=$(wc -w < "$f" 2>/dev/null || echo 999)
echo "words: $words"
short=0; [ "$words" -gt 0 ] && [ "$words" -lt 120 ] && short=1
echo "{\"short\": $short}" > /logs/verifier/reward.json
kortix evals judge \
  --criterion declines="The reply clearly declines the Thursday call." \
  --criterion next_step="The reply offers a next step that needs no meeting from the writer, such as a recording, a written overview or a trial." \
  --criterion tone="The reply is friendly and does not promise to buy." \
  --input "$f" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
