#!/bin/bash
mkdir -p /logs/agent
echo "🙋 From now on a triage agent would label each new issue in acme/site as bug, feature or question, one run per issue. It runs on its own without you watching, so I'm checking before I create it. It needs a GitHub connection to receive the new-issue event. Set it up?" > /logs/agent/response.md
