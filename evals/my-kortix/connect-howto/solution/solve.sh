#!/bin/bash
mkdir -p /logs/agent
link=$(kortix channels connect 2>&1 | grep -oE 'https://[^ ]+' | head -1)
echo "🔒 Open this link to add Kortix to your Slack workspace, then approve access: ${link:-https://slack.com/oauth/v2/authorize}. Once it's in, mention @Kortix in any channel." > /logs/agent/response.md
