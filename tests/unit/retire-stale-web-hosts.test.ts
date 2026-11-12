import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readWorkflow, REPO_ROOT as root } from '../src/fixtures/repo';

const script = resolve(root, 'infra/scripts/retire-stale-web-hosts.sh');
const workflowName = 'retire-stale-web-hosts.yml';

// KRTX-3365: new.kortix.com and prod-test.kortix.com are retired web hosts.
// Their Cloudflare CNAME records still point at Vercel's vanity DNS target,
// but no Vercel project claims the domains any more, so Vercel serves its
// cached certificate until it expires and never renews it. The fix is
// deleting the two stale records from the kortix.com zone (Cloudflare).

/**
 * Drives the REAL infra/scripts/retire-stale-web-hosts.sh with a stubbed
 * `curl` placed first on PATH. The stub serves the Cloudflare API responses
 * from per-host state files and rewrites the state on DELETE, so the
 * script's post-delete verification reads back an empty list.
 */
const CURL_STUB = String.raw`#!/usr/bin/env bash
set -euo pipefail
url=""
method=GET
while [ $# -gt 0 ]; do
  case "$1" in
    -X|--request) method="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
# Extract the query's name=<host> from a list URL, or the record id from a
# delete URL (.../dns_records/<id>).
case "$method" in
  GET)
    host="$(printf '%s' "$url" | sed -n 's/.*[?&]name=\([^&]*\).*/\1/p')"
    file="$STUB_DIR/state/$host.json"
    [ -f "$file" ] || { printf '{"success":true,"result":[],"result_info":{"count":0}}\n'; exit 0; }
    cat "$file"
    ;;
  DELETE)
    id="$(printf '%s' "$url" | sed -n 's|.*/dns_records/||p' | tr -d '/')"
    printf '%s\n' "$id" >>"$STUB_DIR/deletes.log"
    found=0
    for f in "$STUB_DIR"/state/*.json; do
      [ -f "$f" ] || continue
      if jq -e --arg id "$id" 'any(.result[]; .id == $id)' "$f" >/dev/null 2>&1; then
        # STUB_STICKY=1 keeps the record listed: the API answers success but
        # the record survives, the script's post-delete guard must catch it.
        if [ "$STUB_STICKY" != "1" ]; then
          jq --arg id "$id" '(.result) |= map(select(.id != $id))' "$f" >"$f.tmp"
          mv "$f.tmp" "$f"
        fi
        found=1
      fi
    done
    [ "$found" = 1 ] || { echo "stub curl: DELETE for unknown id $id" >&2; exit 22; }
    printf '{"success":true}\n'
    ;;
  *)
    echo "stub curl: unhandled method $method" >&2
    exit 22
    ;;
esac
`;

interface HostFixture {
  /** DNS records the zone holds for the host (empty = already retired). */
  records: { id: string; type: string; name: string; content: string }[];
}

function hostState(fixture: HostFixture): string {
  return JSON.stringify({ success: true, result: fixture.records });
}

interface RunResult {
  status: number | null;
  stderr: string;
  deletes: string[];
}

function run(
  hosts: string[],
  fixtures: Record<string, HostFixture>,
  env: Record<string, string> = {},
): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'retire-stale-web-hosts-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'deletes.log'), '');
  const bin = join(dir, 'bin');
  const state = join(dir, 'state');
  spawnSync('mkdir', ['-p', bin, state]);
  writeFileSync(join(bin, 'curl'), CURL_STUB);
  chmodSync(join(bin, 'curl'), 0o755);
  for (const [host, fixture] of Object.entries(fixtures)) {
    writeFileSync(join(state, `${host}.json`), hostState(fixture));
  }
  const result = spawnSync('bash', [script, ...hosts], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CLOUDFLARE_ZONE_ID: 'zone123',
      CLOUDFLARE_API_TOKEN: 'token123',
      STUB_DIR: dir,
      STUB_STICKY: '0',
      ...env,
    },
  });
  const deletes = readFileSync(join(dir, 'deletes.log'), 'utf8').trim().split('\n').filter(Boolean);
  return { status: result.status, stderr: result.stderr, deletes };
}

const VERCEL_TARGET = 'b354e89a4e305237.vercel-dns-016.com';

describe('retire-stale-web-hosts', () => {
  it('deletes the stale Vercel CNAME of each retired host and verifies the empty zone', () => {
    const result = run(['new.kortix.com', 'prod-test.kortix.com'], {
      'new.kortix.com': {
        records: [{ id: 'rec-new', type: 'CNAME', name: 'new.kortix.com', content: VERCEL_TARGET }],
      },
      'prod-test.kortix.com': {
        records: [
          {
            id: 'rec-prod-test',
            type: 'CNAME',
            name: 'prod-test.kortix.com',
            content: VERCEL_TARGET,
          },
        ],
      },
    });

    expect(result.status).toBe(0);
    expect(result.deletes.sort()).toEqual(['rec-new', 'rec-prod-test']);
  });

  it('treats a host with no zone records as already retired and deletes nothing', () => {
    const result = run(['new.kortix.com'], { 'new.kortix.com': { records: [] } });

    expect(result.status).toBe(0);
    expect(result.deletes).toEqual([]);
  });

  it('refuses to delete a record that no longer points at the stale Vercel target', () => {
    const result = run(['new.kortix.com'], {
      'new.kortix.com': {
        records: [
          {
            id: 'rec-live',
            type: 'CNAME',
            name: 'new.kortix.com',
            content: 'something-else.example',
          },
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.deletes).toEqual([]);
    expect(result.stderr).toContain('refused');
  });

  it('refuses to delete a non-CNAME record', () => {
    const result = run(['new.kortix.com'], {
      'new.kortix.com': {
        records: [{ id: 'rec-a', type: 'A', name: 'new.kortix.com', content: '192.0.2.1' }],
      },
    });

    expect(result.status).toBe(1);
    expect(result.deletes).toEqual([]);
    expect(result.stderr).toContain('refused');
  });

  it('refuses a whole host when any of its records fails the guard, deleting none', () => {
    const result = run(['new.kortix.com'], {
      'new.kortix.com': {
        records: [
          { id: 'rec-stale', type: 'CNAME', name: 'new.kortix.com', content: VERCEL_TARGET },
          { id: 'rec-txt', type: 'TXT', name: 'new.kortix.com', content: 'something' },
        ],
      },
    });

    expect(result.status).toBe(1);
    expect(result.deletes).toEqual([]);
  });

  it('fails when the post-delete verification still lists a record', () => {
    // STUB_STICKY=1 keeps the record listed: the API answers success but the
    // record survives, and the script must catch the failed retirement.
    const result = run(
      ['new.kortix.com'],
      {
        'new.kortix.com': {
          records: [
            { id: 'rec-sticky', type: 'CNAME', name: 'new.kortix.com', content: VERCEL_TARGET },
          ],
        },
      },
      { STUB_STICKY: '1' },
    );

    expect(result.status).toBe(1);
    expect(result.deletes).toEqual(['rec-sticky']);
  });

  it('requires CLOUDFLARE_ZONE_ID and CLOUDFLARE_API_TOKEN', () => {
    const result = run(
      ['new.kortix.com'],
      { 'new.kortix.com': { records: [] } },
      {
        CLOUDFLARE_ZONE_ID: '',
        CLOUDFLARE_API_TOKEN: '',
      },
    );

    expect(result.status).toBe(1);
  });

  describe('workflow wiring', () => {
    it('runs on dispatch only, never on a push or pull request', () => {
      const workflow = readWorkflow(workflowName);
      const on = workflow.indexOf('on:');
      const jobs = workflow.indexOf('jobs:');
      const triggers = workflow.slice(on, jobs);
      expect(triggers).toContain('workflow_dispatch');
      expect(triggers).not.toContain('push');
      expect(triggers).not.toContain('pull_request');
      expect(triggers).not.toContain('schedule');
    });

    it('reads the zone-scoped Cloudflare token through the aws-env action', () => {
      const workflow = readWorkflow(workflowName);
      expect(workflow).toContain('kortix-ci-env:CLOUDFLARE_APPS_EDGE_API_TOKEN');
      expect(workflow).toContain('./.aws-env/.github/actions/aws-env');
      expect(workflow).toContain('CLOUDFLARE_ZONE_ID: ${{ vars.CLOUDFLARE_ZONE_ID }}');
    });

    it('retires exactly the two stale hosts through the script', () => {
      const workflow = readWorkflow(workflowName);
      expect(workflow).toContain('bash infra/scripts/retire-stale-web-hosts.sh');
      expect(workflow).toContain("'new.kortix.com' 'prod-test.kortix.com'");
    });
  });
});
