#!/bin/bash
set -e
kortix triggers enable morning-summary --apply
mkdir -p /logs/agent; echo "✅ The schedule was switched off. It is on again: the next summary comes tomorrow at 8:00." > /logs/agent/response.md
