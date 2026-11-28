#!/bin/bash
# skill: a new workspace skill on main mentions refunds. rules: it holds all three rules (judged). agent / no_secrets / uses_skill: support-replies exists, has no secrets, and may load that skill. drafts_only: its instructions forbid sending by itself (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
BASE_SKILLS = {'agent-browser', 'convert-documents-to-markdown', 'design-foundations', 'docx', 'pdf', 'presentations', 'web-publishing-and-deployments'}
def workspace_skills():
    """The `skills:` map of kortix.yaml on main, as {name: folder}."""
    text = sh('kortix files cat kortix.yaml 2>/dev/null'); out, inside = {}, False
    for line in text.splitlines():
        if re.match(r'^skills:\s*$', line): inside = True; continue
        if inside:
            m = re.match(r'^\s+([A-Za-z0-9_.-]+):\s*(\S+)', line)
            if m: out[m.group(1)] = m.group(2).strip('"\''); continue
            if line.strip() and not line.startswith(' '): break
    return out
def refund_skill():
    """The new skill whose text mentions refunds: (name, text), or (None, '')."""
    for name, folder in workspace_skills().items():
        if name in BASE_SKILLS: continue
        text = sh(f"kortix files cat {json.dumps(folder.rstrip('/') + '/SKILL.md')} 2>/dev/null")
        if re.search(r'refund', text, re.I): return name, text
    return None, ''
def support():
    return (kj('agents config support-replies') or {}).get('block') or {}
none = lambda v: v in (None, 'none', [], '')
name, text = refund_skill(); a = support()
granted = a.get('skills')
uses = name is not None and (granted in ('all', '*') or (isinstance(granted, list) and (name in granted or '*' in granted or 'all' in granted)))
prompt = json.dumps((a.get('behavior') or {}).get('prompt') or a.get('prompt') or '')
open(f'{V}/judge-input.md', 'w').write('Skill text:\n' + (text or '(no refund skill on main)')[:6000] + '\n\n---\nAgent instructions:\n' + json.loads(prompt)[:4000] + '\n')
open(f'{V}/state.json', 'w').write(json.dumps({'skills': workspace_skills(), 'refund_skill': name, 'support': a}, indent=1))
save({'skill': 1 if name else 0, 'agent': 1 if a else 0, 'no_secrets': 1 if a and none(a.get('secrets')) else 0, 'uses_skill': 1 if uses else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
judge \
  --criterion rules="The skill text says all three rules: refunds within 30 days with a receipt; store credit after 30 days; no refunds on sale items." \
  --criterion drafts_only="The agent instructions say it drafts replies and never sends anything itself (a person sends, or approves first)." \
  --input /logs/verifier/judge-input.md
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
