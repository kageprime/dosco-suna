#!/bin/bash
# job + style: My Kortix saved both facts to its memory of this person (the pages the next session reads).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def memory_text():
    """Every page My Kortix keeps about this person, as text."""
    text = ''
    for f in drive_files('~/Memory/mykortix', depth=1):
        path = f.get('path') or f"~/Memory/mykortix/{f.get('name')}"
        # The page's body only: a deleted page can still be listed, and its file name is not what is remembered.
        text += "\n---\n" + sh(f"kortix drive cat {json.dumps(path)} 2>/dev/null")
    open(f'{V}/memory.txt', 'w').write(text)
    return text
text = memory_text().lower()
save({'job': 1 if 'bakery' in text else 0, 'style': 1 if re.search(r'bullet', text) else 0})
PY
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
