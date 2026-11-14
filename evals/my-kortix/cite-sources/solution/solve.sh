#!/bin/bash
# Reads the newest release from python.org at run time: the answer changes over time, so a written one would go stale.
mkdir -p /workspace
python3 - <<'PY'
import re, urllib.request
url = 'https://www.python.org/downloads/'
html = urllib.request.urlopen(url, timeout=30).read().decode('utf-8', 'replace')
version = re.search(r'Download Python (\d+\.\d+\.\d+)', html).group(1)
date = re.search(r'Python ' + re.escape(version) + r'</a>\s*</span>\s*<span class="release-date">([^<]+)<', html)
when = date.group(1).strip() if date else 'the date listed on the downloads page'
open('/workspace/brief.md', 'w').write(
    f'The latest stable release of Python is {version}, released {when}. '
    f'It is the release the official downloads page offers first.\n\nSource: {url}\n'
)
PY
