#!/bin/bash
set -e
cat > /tmp/person.md <<'MD'
---
name: person
description: How they like answers
type: user
---
Wants answers as short bullet lists.
MD
kortix drive put /tmp/person.md "~/Memory/mykortix/person.md"
mkdir -p /logs/agent; echo "✅ Forgotten: where you work. I still keep your answers to short bullet lists." > /logs/agent/response.md
