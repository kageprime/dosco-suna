#!/bin/bash
set -e
kortix connectors add deepwiki --provider mcp --url https://mcp.deepwiki.com/mcp --transport http --apply
kortix connectors call deepwiki read_wiki_structure '{"repoName": "facebook/react"}' > /tmp/wiki.json
mkdir -p /logs/agent
python3 - <<'PY' > /logs/agent/response.md
import json, re
texts = []
def walk(n):
    if isinstance(n, dict):
        for k, v in n.items(): texts.append(v) if k == 'text' and isinstance(v, str) else walk(v)
    elif isinstance(n, list):
        for v in n: walk(v)
walk(json.load(open('/tmp/wiki.json')))
print('✅ DeepWiki is connected. The top-level sections for facebook/react:')
print('\n'.join(re.findall(r'^\s*-\s+\d+\s+.+$', '\n'.join(texts), re.M)))
PY
