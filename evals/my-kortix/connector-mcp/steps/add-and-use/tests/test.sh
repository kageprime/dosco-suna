#!/bin/bash
# added + connected: a connector for the DeepWiki URL exists and answers (the grader calls it). used: the reply lists at least 4 of the top-level sections the connector returns, which only a call to it gives.
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
found = []
for c in rows(kj('connectors ls'), 'connectors'):
    detail = kj(f"connectors show {c.get('slug')}") or {}
    if 'deepwiki' in json.dumps([c, detail]).lower(): found.append(c)
open(f'{V}/connectors.json', 'w').write(json.dumps(found, indent=1))
sections = []
args = json.dumps(json.dumps({'repoName': 'facebook/react'}))
for c in found:
    out = sh(f"kortix connectors call {c.get('slug')} read_wiki_structure {args} 2>>{V}/kortix.err")
    sections = re.findall(r'^\s*-\s+\d+\s+(.+?)\s*$', call_text(out), re.M) or sections
open(f'{V}/sections.txt', 'w').write('\n'.join(sections))
text = reply().lower()
named = [t for t in sections if t.lower() in text]
print('sections', sections, 'named', named)
save({'added': 1 if found else 0, 'connected': 1 if sections else 0, 'used': 1 if len(named) >= min(4, len(sections) or 4) else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
