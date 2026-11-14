#!/bin/bash
# link: the reply holds an https link that starts the connection. starts / no_invention / short: judged.
mkdir -p /logs/verifier
link=0; grep -qE 'https://[^ )]+' /logs/agent/response.md 2>/dev/null && link=1
echo "link: $link"
echo "{\"link\": $link}" > /logs/verifier/reward.json
kortix evals judge \
  --criterion starts="The reply starts the Slack connection now: it gives an Add to Slack or sign-in link, or a Connect card, instead of sending the person to a settings page." \
  --criterion no_invention="The reply does not invent menus, API keys or steps that a Kortix user would not see." \
  --criterion short="The reply is a few sentences or a short list, not an essay." \
  --input /logs/agent/response.md || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
