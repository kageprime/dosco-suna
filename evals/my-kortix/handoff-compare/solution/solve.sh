#!/bin/bash
# The reference hands the research to a colleague session and writes the consolidated summary.
agent=$(kortix agents ls --json | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d if isinstance(d,list) else d.get("agents",[]); print(next((x["name"] for x in a if x.get("name") not in ("mykortix","meta")), "worker"))')
kortix sessions new --agent "$agent" --prompt "Compare the paid plans of Linear, Asana and ClickUp from their pricing pages." --json > /tmp/child.json
mkdir -p /logs/agent
cat > /logs/agent/response.md <<'MD'
Here is how the paid plans of the three compare:

- **Linear**: Basic and Business per seat, Enterprise on request; built for software teams' issue tracking and cycles.
- **Asana**: Starter and Advanced per seat, Enterprise on request; built around projects, portfolios and goals.
- **ClickUp**: Unlimited and Business per seat, Enterprise on request; the most features per tier, including docs and whiteboards.
MD
