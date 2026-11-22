#!/bin/bash
set -e
cat > /tmp/person.md <<'MD'
---
name: person
description: Who they are and how they like answers
type: user
---
Runs operations at a bakery chain with 40 people. Wants answers as short bullet lists.
MD
kortix drive put /tmp/person.md "~/Memory/mykortix/person.md"
mkdir -p /logs/agent; echo "💡 Noted: you run operations at a 40-person bakery chain, and you like short bullet lists." > /logs/agent/response.md
