#!/bin/bash
when=$(date -u -d '+48 hours' +%Y-%m-%dT08:00:00Z)
kortix loop "Check in with the person on the 3 bakery catering quotes (Brot & Co, Kornblume, Hefezopf). They relay the replies in this chat; the pick is due $(date -u -d '+3 days' +%F). Ask which replies came in and which are still missing, then compare what came in." --at "$when"
mkdir -p /logs/agent; echo "⏳ I'll check in on $(date -u -d '+48 hours' +%F) in the morning about the three bakery quotes." > /logs/agent/response.md
