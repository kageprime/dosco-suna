import { spawn } from 'bun';
import { run, which } from './exec';

export async function ensureRuntimeArtifacts(worktreePath: string): Promise<number> {
  const packageBuilds: Array<[string, string]> = [
    ['sandbox agent', 'kortixd'],
    ['CLI', '@kortix/cli'],
  ];
  for (const [label, filter] of packageBuilds) {
    console.log(`  building ${label} runtime artifact`);
    const code = await run(['pnpm', '--filter', filter, 'build'], { cwd: worktreePath });
    if (code !== 0) return code;
  }
  const [label, script] = ['Apps runtime', 'apps/kortix-app-runtime/build.sh'];
  // The Apps runtime is a Go binary that only the local full stack consumes.
  // A box without Go (a Kortix session sandbox) still gets a usable worktree.
  if (!which('go')) {
    console.warn(`  skipping ${label} runtime artifact: go is not installed (Kortix Apps will not run in this worktree)`);
    return 0;
  }
  console.log(`  building ${label} runtime artifact`);
  const code = await run(['bash', script], { cwd: worktreePath });
  if (code !== 0) return code;
  return 0;
}

// Spawn `cmd`, drain its stdout+stderr and resolve the first regex match (the
// tunnel URL and the stripe signing secret both print to the child's output).
// Piping in-memory avoids a temp file entirely — no predictable /tmp path to leak
// the `whsec_` secret through and no create-then-read race. The process is left
// running on a match; the caller owns its lifecycle. A miss kills it. Null when
// the binary is missing or nothing matched within `attempts` seconds.
export async function spawnForFirstMatch(
  cmd: [string, ...string[]],
  re: RegExp,
  attempts: number,
): Promise<{ match: string; proc: ReturnType<typeof Bun.spawn> } | null> {
  if (!which(cmd[0])) return null;
  const proc = spawn(cmd, {
    stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  let buf = '';
  const pump = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
    if (!stream) return;
    const dec = new TextDecoder();
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        // The pumps outlive the match so the child's pipes stay drained for
        // its whole life (a full pipe stalls cloudflared). Keep the tail only.
        if (buf.length > 65_536) buf = buf.slice(-32_768);
      }
    } catch { /* stream closed when the process is killed */ }
  };
  void pump(proc.stdout as ReadableStream<Uint8Array>);
  void pump(proc.stderr as ReadableStream<Uint8Array>);
  for (let i = 0; i < attempts; i++) {
    const m = buf.match(re);
    if (m) return { match: m[0], proc };
    if (proc.exitCode !== null) break;
    await Bun.sleep(1000);
  }
  try { proc.kill(); } catch {}
  return null;
}

export interface Tunnel { url: string; proc: ReturnType<typeof Bun.spawn>; }

/** True when the quick tunnel's public URL answers the API health route. */
export async function tunnelAnswers(url: string, apiPath = '/v1/health', timeoutMs = 8000): Promise<boolean> {
  try {
    const r = await fetch(`${url}${apiPath}`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startTunnel(apiPort: number): Promise<Tunnel | null> {
  // `--protocol http2`: quick tunnels default to QUIC, and on a UDP-hostile or
  // congested path the single QUIC connection drops and never re-registers —
  // the hostname dies while the process lives (2026-08-22: five quick tunnels
  // died within 10–30 min each; cloudflared metrics showed
  // quic_client_congestion_state 3 on every one). HTTP/2 rides TCP/443 and
  // reconnects like any HTTPS client. The watchdog still covers a real death.
  const hit = await spawnForFirstMatch(['cloudflared', 'tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${apiPort}`], /https:\/\/[a-z0-9.-]+\.trycloudflare\.com/, 30);
  return hit && { url: hit.match, proc: hit.proc };
}

export interface StripeListen { secret: string; proc: ReturnType<typeof Bun.spawn>; }

// Forward Stripe (test-mode) webhooks to THIS worktree's API — the shared
// `pnpm stripe:listen` is hardcoded to :8008, so without this a worktree's
// checkout/subscription webhooks would never reach its own API. Captures the
// `whsec_…` signing secret `stripe listen` prints so the handler can verify
// signatures. Returns null if the stripe CLI is missing or not logged in
// (`stripe login`), in which case it just times out.
export async function startStripeListen(apiPort: number): Promise<StripeListen | null> {
  const forwardTo = `http://localhost:${apiPort}/v1/billing/webhooks/stripe`;
  const hit = await spawnForFirstMatch(['stripe', 'listen', '--forward-to', forwardTo], /whsec_[A-Za-z0-9]+/, 20);
  return hit && { secret: hit.match, proc: hit.proc };
}
