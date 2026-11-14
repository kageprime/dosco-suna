#!/bin/bash
mkdir -p /workspace
cat > /workspace/migration-plan.md <<'MD'
# Trello → Linear migration

## Phases
- **Week 1 — Prepare** (owner: engineering manager): map Trello lists to Linear workflow states, labels to labels, create the Linear teams, invite the 12 members.
- **Week 2 — Import** (owner: team lead): import open cards with the Linear Trello importer, check 20 random issues, fix the mapping, re-import.
- **Week 3 — Switch** (owner: engineering manager): Linear becomes the source of truth on Monday; Trello boards turn read-only.
- **Week 4 — Clean up** (owner: team lead): close stale issues, archive Trello.

## What moves
Open cards, their comments and attachments, labels, members, due dates.

## What does not move
Archived boards and closed cards (they stay readable in Trello); Power-Ups and automations (rebuilt in Linear where needed).

## Risks
1. **Lost context in import** — test on one board first and compare 20 issues by hand.
2. **People keep using Trello** — make boards read-only on switch day and post the Linear link in every board's description.
3. **Workflow mismatch** — agree on the state mapping in week 1 with every team lead before importing.
MD
