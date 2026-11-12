---
recorded: 2026-11-11T18:59:30Z
incident_date: 2026-11-11
---
# Probe a sandbox host's data plane through a real signed preview request, never through a loopback or 404 check

**Rule:** A host health check must send the request a real preview sends: a CP-signed route hint for a sandbox placed on that host, through the host edge, to the guest. A loopback `404`, an open `:80`, or a host-agent heartbeat proves nothing about the data plane. When a session looks stuck on "Gathering thoughts…" with a non-empty queue, check the box's reachability first: `kortix sessions queue <session_id> --json` shows `the session's machine could not be reached`, then compare an in-box `curl localhost:8000/kortix/health` (Platinum `exec`) against the same path through the preview edge.

**Trigger surface:** A report that a session is stuck working, or that queued messages never deliver. Writing or changing a Platinum host health check, `proxy_reachable`, or the edge's route lookup. Any per-host outage on Platinum.

**Incident:** 2026-11-11, Kortix v0.15.7, Platinum prod `263e30c`.
- `platinum-edge-proxy` on 2 of 6 eu-west hosts hung every preview request until its ~30 s idle timeout. The CP answered `502 upstream-closed-before-headers` after 32 s.
- 33 of 90 running boxes (37%) were unreachable from the Kortix API. Their sessions showed "Gathering thoughts…", and queued prompts failed with "the session's machine could not be reached". One session had a 9-minute gap with no delivery.
- The guests were healthy: the in-box daemon answered in 4 ms. Platinum reported `proxy_reachable: true` on both hosts the whole time, so nothing alerted and nothing repaired.
- A request without a token also hung, so the hang sits before the edge's token gate: the route hint check or its Postgres fallback, which hosts cannot reach.
- Mitigation: `deploy-hosts.yml` with `edge_only=true` on each host restarted only the edge. Afterwards 36 of 36 boxes on those hosts answered. Root cause and follow-ups: kortix-ai/platinum#3249.

**Enforcement:** none yet: a synthetic per-host probe in Platinum that sends a signed hint for a live sandbox on each host and restarts the edge after N failures (kortix-ai/platinum#3249).
