#!/bin/bash
# started_right: it asks once first, or it already set it up (both are fine for an internal change).
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
name, _ = refund_skill()
save({'started_right': 1 if asked_person() or name or support() else 0})
PY
[ $? = 0 ] || { echo "the grader crashed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
