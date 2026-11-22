#!/bin/bash
set -e
kortix loop "Ask the person whether the flour supplier's price quote came in (promised within two days of the email). If it did, compare it; if not, ask again tomorrow; stop after 5 days." --in 30h
mkdir -p /logs/agent; echo "⏳ I'll check in with you the day after tomorrow on the flour quote." > /logs/agent/response.md
