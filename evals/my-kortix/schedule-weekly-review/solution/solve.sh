#!/bin/bash
kortix loop "Review the weekly metrics." --cron "0 0 9 * * 1" --timezone Europe/Berlin
mkdir -p /logs/agent; echo "✅ Every Monday at 9:00 (Berlin time) I'll remind you to review the weekly metrics." > /logs/agent/response.md
