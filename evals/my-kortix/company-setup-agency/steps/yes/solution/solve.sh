#!/bin/bash
cat > /tmp/writer.json <<"EOF"
{"behavior":{"prompt":"You draft social posts for the agency's clients.","description":"Drafts social posts","mode":"subagent","hidden":true},"tools":["read","write","web_search"]}
EOF
kortix agents config content-writer --file /tmp/writer.json --json
out=$(kortix triggers add "Write this week's client report to Reports/weekly.md in Drive." --runtime --cron "0 9 * * 1" --timezone Europe/Berlin --agent worker 2>&1)
id=$(echo "$out" | grep -oE 'trigger\.[0-9a-f]+' | head -1); kortix triggers pause "$id"
kortix access invite ana@example.test --role member
mkdir -p /logs/agent; echo "✅ Created content-writer; saved the Monday report paused until it is tested; invited ana@example.test as a member." > /logs/agent/response.md
