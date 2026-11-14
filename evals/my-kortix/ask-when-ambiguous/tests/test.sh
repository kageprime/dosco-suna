#!/bin/bash
# The request names neither the update nor the channel: the right move is to ask.
mkdir -p /logs/verifier
echo '{}' > /logs/verifier/reward.json
# A question asked with the question tool is a card, not reply text: give the judge both.
kortix sessions pending "$KORTIX_SESSION_ID" --json > /logs/verifier/pending.json 2>/dev/null || echo '[]' > /logs/verifier/pending.json
kortix evals judge \
  --criterion asks="The reply asks which update is meant or asks for its content." \
  --criterion channel="The reply asks how or where to reach the team, or names the options." \
  --criterion no_invention="The reply does not claim to have sent anything and does not invent an update's content." \
  --input /logs/agent/response.md --input /logs/verifier/pending.json || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
