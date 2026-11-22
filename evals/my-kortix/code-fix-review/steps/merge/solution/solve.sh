#!/bin/bash
set -e
n=$(kortix cr ls --json | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d if isinstance(d,list) else d["change_requests"]; print(r[0]["number"])')
kortix cr merge "$n"
mkdir -p /logs/agent; echo "✅ Merged: invoices now take the discount off the amount." > /logs/agent/response.md
