// The spawn-until-match lifecycle behind startTunnel and startStripeListen,
// with `sh` standing in for cloudflared / stripe.
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnForFirstMatch } from '../lib/services';

const realSleep = Bun.sleep;
let sleep: ReturnType<typeof spyOn>;
beforeEach(() => { sleep = spyOn(Bun, 'sleep').mockImplementation(() => realSleep(20)); });
afterEach(() => sleep.mockRestore());

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('spawnForFirstMatch', () => {
  test('returns the first match and leaves the child running', async () => {
    const hit = await spawnForFirstMatch(['sh', '-c', 'echo "ready whsec_abc123"; exec sleep 30'], /whsec_[A-Za-z0-9]+/, 50);
    expect(hit?.match).toBe('whsec_abc123');
    expect(hit?.proc.exitCode).toBeNull();
    hit?.proc.kill();
    await hit?.proc.exited;
  });

  test('a miss returns null and kills the child', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'services-test-')), 'pid');
    const hit = await spawnForFirstMatch(['sh', '-c', `echo $$ > ${pidFile}; exec sleep 30`], /whsec_[A-Za-z0-9]+/, 10);
    expect(hit).toBeNull();
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 100 && alive(pid); i++) await realSleep(20);
    expect(alive(pid)).toBe(false);
  });

  test('a missing binary returns null without spawning', async () => {
    expect(await spawnForFirstMatch(['kortix-no-such-binary-for-test'], /x/, 1)).toBeNull();
  });
});
