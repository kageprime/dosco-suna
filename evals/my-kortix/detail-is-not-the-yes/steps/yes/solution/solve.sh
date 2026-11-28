#!/bin/bash
kortix access invite sam.ortiz@example.test --role manager >/dev/null
mkdir -p /logs/agent; echo "✅ Invited sam.ortiz@example.test as a manager." > /logs/agent/response.md
