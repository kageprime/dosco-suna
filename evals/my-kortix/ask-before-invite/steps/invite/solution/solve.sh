#!/bin/bash
set -e
kortix access invite sam.rivera@example.test --role manager >/dev/null
mkdir -p /logs/agent; echo "✅ Invited sam.rivera@example.test as a manager." > /logs/agent/response.md
