#!/bin/bash
set -e
kortix triggers add morning-summary --type cron --cron "0 8 * * 1-5" --timezone Europe/Berlin --agent worker \
  --prompt "Write a short summary of yesterday's sessions in this workspace and save it to the person's Drive." --apply
mkdir -p /logs/agent; echo "✅ Set: every weekday at 8:00 Berlin time the summary of yesterday's sessions lands in your Drive." > /logs/agent/response.md
