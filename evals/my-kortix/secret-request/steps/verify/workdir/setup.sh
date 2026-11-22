#!/bin/bash
# The person fills in the link: the secret gets its value.
python3 - <<'PY'
import sys; sys.path.insert(0, '/tests')
from kx import *
def secret_name():
    """The name the person's secret link asks for: the link My Kortix gave them, as the API reads it."""
    names = secret_link(session_text())
    return names[0] if names else 'ACME_API_KEY'

def secret_value():
    """What the person typed into the link, derived from the trial: the agent never saw how."""
    import hashlib
    return hashlib.sha256(f"{os.environ.get('KORTIX_EVAL_TRIAL_ID', '')}:acme-bench".encode()).hexdigest()[:32]
name = secret_name()
print(name, sh(f"printf %s {secret_value()} | kortix secrets set {name}=- 2>&1"))
PY
