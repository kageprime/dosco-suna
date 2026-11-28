#!/bin/bash
kortix drive rm "~/old-plan.md"
mkdir -p /logs/agent; echo "✅ Deleted old-plan.md." > /logs/agent/response.md
