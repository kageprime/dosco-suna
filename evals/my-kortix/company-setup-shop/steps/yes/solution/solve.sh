#!/bin/bash
set -e
cd /workspace && kortix workspaces clone > /tmp/clone.txt 2>&1
dir=$(dirname "$(find /workspace -maxdepth 3 -name kortix.yaml | head -1)")
cd "$dir"
mkdir -p skills/refund-policy && cat > skills/refund-policy/SKILL.md <<"EOF"
---
name: refund-policy
description: The shop's refund policy. Load it before answering any refund question.
---
- Refunds within 30 days of purchase, with a receipt.
- After 30 days: store credit, no refund.
- No refunds on sale items.
EOF
python3 - <<"PY2"
import re
p = 'kortix.yaml'; s = open(p).read(); entry = '  refund-policy: skills/refund-policy'
if re.search(r'^skills:[ \t]*\{[ \t]*\}[ \t]*$', s, re.M):
    s = re.sub(r'^skills:[ \t]*\{[ \t]*\}[ \t]*$', 'skills:\n' + entry, s, count=1, flags=re.M)
elif re.search(r'^skills:[ \t]*$', s, re.M):
    s = re.sub(r'^skills:[ \t]*$', 'skills:\n' + entry, s, count=1, flags=re.M)
else:
    s = s.rstrip('\n') + '\n\nskills:\n' + entry + '\n'
open(p, 'w').write(s)
PY2
git add -A && git -c user.email=oracle@example.test -c user.name=oracle commit -qm "Add the refund-policy skill"
git push -q origin HEAD
kortix cr open --title "Add the refund-policy skill" --description "The shop's refund policy as a skill." > /tmp/cr.txt
n=$(kortix cr ls --json | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d if isinstance(d,list) else d["change_requests"]; print(r[0]["number"])')
kortix cr merge "$n"
cat > /tmp/support.json <<"EOF"
{"behavior":{"prompt":"You draft replies to customers. Follow the refund-policy skill. You never send anything yourself: a person reviews and sends every reply.","description":"Drafts customer replies","mode":"subagent","hidden":true},"skills":["refund-policy"],"tools":["read","write"]}
EOF
kortix agents config support-replies --file /tmp/support.json --json
mkdir -p /logs/agent; echo "✅ Added the refund-policy skill and the support-replies agent: drafts only, no secrets." > /logs/agent/response.md
