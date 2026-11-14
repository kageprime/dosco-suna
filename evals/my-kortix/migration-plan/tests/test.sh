#!/bin/bash
# exists: the file has content. phases, scope, risks: judged.
mkdir -p /logs/verifier
f=/workspace/migration-plan.md
exists=0; [ -s "$f" ] && exists=1
echo "{\"exists\": $exists}" > /logs/verifier/reward.json
[ "$exists" = 1 ] || { echo '{"exists": 0, "phases": 0, "scope": 0, "risks": 0}' > /logs/verifier/reward.json; exit 0; }
kortix evals judge \
  --criterion phases="The plan has phases on a week-by-week timeline, each with an owner role." \
  --criterion scope="The plan says what moves to Linear (such as open cards, labels, members) and what does not (such as archived boards)." \
  --criterion risks="The plan names three risks, each with a concrete way to reduce it." \
  --input "$f" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
