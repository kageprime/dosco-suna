#!/bin/bash
set -e
kortix members invite sam.rivera@example.test --role admin
mkdir -p /logs/agent; echo "✅ Invited sam.rivera@example.test as an admin." > /logs/agent/response.md
