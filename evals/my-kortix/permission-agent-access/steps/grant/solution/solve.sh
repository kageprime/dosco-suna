#!/bin/bash
set -e
kortix agents scope reporter --secrets WAREHOUSE_TOKEN
mkdir -p /logs/agent; echo "✅ The reporter agent can use the warehouse token now." > /logs/agent/response.md
