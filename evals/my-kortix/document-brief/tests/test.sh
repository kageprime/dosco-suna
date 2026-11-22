#!/bin/bash
# saved: a .docx is in the person's Drive. roles: it names the three roles and March. brief: a one-page hiring brief (judged).
mkdir -p /logs/verifier
judge() { kortix evals judge "$@" || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }; }
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
import zipfile
docs = [f for f in drive_files('~') if str(f.get('name', '')).lower().endswith('.docx')]
ok = docs and drive_get(docs[0].get('path') or f"~/{docs[0]['name']}", '/tmp/brief.docx')
text = ''
if ok:
    try: text = re.sub(r'<[^>]+>', ' ', zipfile.ZipFile('/tmp/brief.docx').read('word/document.xml').decode('utf8', 'replace'))
    except Exception as e: print('not a docx:', e); ok = False
open(f'{V}/brief.txt', 'w').write(re.sub(r'\s+', ' ', text))
low = text.lower()
save({'saved': 1 if ok else 0, 'roles': 1 if all(w in low for w in ('baker', 'driver', 'shift lead', 'march')) else 0})
PY
judge \
  --criterion brief="The document is a one-page hiring brief: it says why the plan exists, what each of the three roles (baker, delivery driver, shift lead) does, and that all start by the end of March." \
  --input /logs/verifier/brief.txt
python3 -c 'import sys; sys.path.insert(0, "/tests"); import kx; kx.finalize()'
exit 0
