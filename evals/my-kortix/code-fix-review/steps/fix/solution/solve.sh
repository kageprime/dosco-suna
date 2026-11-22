#!/bin/bash
set -e
cd /workspace && kortix workspaces clone > /tmp/clone.txt 2>&1
dir=$(find /workspace -maxdepth 3 -name invoice.py -path '*tools*' | head -1 | xargs dirname | xargs dirname)
cd "$dir"
sed -i 's|return round(amount \* discount_pct / 100, 2)|return round(amount * (1 - discount_pct / 100), 2)|' tools/invoice.py
git -c user.email=oracle@example.test -c user.name=oracle commit -qam "Fix the invoice discount"
git push -q origin HEAD
kortix cr open --title "Fix the invoice discount" --description "10% off 200 is 180, not 20." > /tmp/cr.txt
mkdir -p /logs/agent; echo "🙋 The fix is ready for your review: a change request that makes 10% off 200 come out as 180. Merge it?" > /logs/agent/response.md
