import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { createTokenRateLimit } from './token-rate-limit';

const request = (path: string, headers: Record<string, string>) =>
  new Request(`https://gateway.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"model":"x","messages":[]}',
  });

afterEach(() => setSystemTime());

describe('per-credential request limit', () => {
  test('refuses the request over the limit with 429 and Retry-After, and the next minute admits it again', async () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    limit.validated('kortix_sb_a');
    const call = () =>
      limit(request('/v1/chat/completions', { authorization: 'Bearer kortix_sb_a' }));
    expect(call()).toBeNull();
    expect(call()).toBeNull();
    const refused = call();
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('30');
    const body = (await refused?.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');

    setSystemTime(new Date('2026-11-02T12:00:30Z'));
    expect(call()).toBeNull();
  });

  test('counts each validated credential apart, and x-api-key is a credential', () => {
    const limit = createTokenRateLimit(1);
    for (const credential of ['kortix_sb_a', 'kortix_sb_b', 'kortix_gw_c'])
      limit.validated(credential);
    const call = (credential: string) =>
      limit(request('/v1/chat/completions', { authorization: `Bearer ${credential}` }));
    expect(call('kortix_sb_a')).toBeNull();
    expect(call('kortix_sb_a')?.status).toBe(429);
    expect(call('kortix_sb_b')).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))).toBeNull();
    expect(limit(request('/v1/messages', { 'x-api-key': 'kortix_gw_c' }))?.status).toBe(429);
  });

  test('does not count a request without a credential: the pipeline refuses it with 401 and no API call', () => {
    const limit = createTokenRateLimit(1);
    for (let i = 0; i < 5; i++) expect(limit(request('/v1/chat/completions', {}))).toBeNull();
  });

  test('answers Messages and Claude Code requests in the Anthropic envelope', async () => {
    const limit = createTokenRateLimit(1);
    for (const path of ['/v1/messages', '/v1/claude-code/v1/messages']) {
      const headers = { authorization: `Bearer kortix_sb_${path.length}` };
      limit.validated(`kortix_sb_${path.length}`);
      limit(request(path, headers));
      const refused = limit(request(path, headers));
      expect(refused?.status).toBe(429);
      expect(await refused?.json()).toEqual({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Too many requests for this credential. Retry shortly.',
        },
      });
    }
  });
});

describe('credentials the gateway has not validated (KRTX-4528)', () => {
  const fake = (n: number) =>
    request('/v1/chat/completions', { authorization: `Bearer kortix_fake_${n}` });

  test('refuses a flood of never-validated credentials once the shared allowance is spent', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    // A third unseen credential is refused: a fresh fake cannot buy a bucket.
    const refused = limit(fake(3));
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('30');
    // Repeating a fake already admitted does not buy anything either.
    expect(limit(fake(1))?.status).toBe(429);
  });

  test('a flood of never-validated credentials leaves only the one shared bucket', () => {
    const limit = createTokenRateLimit(5);
    for (let i = 0; i < 200; i++) limit(fake(i));
    expect(limit.buckets()).toEqual(['gateway_token:distinct_credentials']);
  });

  test('refunds a credential’s shared slot once, however often it is validated', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    // A request authenticates the same token several times per call (authorize,
    // admit); a second validated() must not refund a slot it never took.
    limit.validated('kortix_fake_1');
    limit.validated('kortix_fake_1');
    expect(limit(fake(3))).toBeNull();
    expect(limit(fake(4))?.status).toBe(429);
  });

  test('validating a credential moves it off the shared bucket and refunds its slot', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(2);
    // Two fakes take the two shared slots, so the allowance is empty.
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(2))).toBeNull();
    expect(limit(fake(9))?.status).toBe(429);
    // The API answered `kortix_fake_1` with a principal: its shared slot is
    // refunded, so exactly one more unvalidated request fits.
    limit.validated('kortix_fake_1');
    expect(limit(fake(8))).toBeNull();
    expect(limit(fake(7))?.status).toBe(429);
    // It also has its own budget now, so repeating it is not the shared limit.
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(1))).toBeNull();
    expect(limit(fake(1))?.status).toBe(429);
  });

  test('a whitespace-bearing bearer is counted like the pipeline counts it', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1);
    // The pipeline's bearer grammar accepts internal whitespace
    // (`/^Bearer\s+(\S.*)$/i` in create-gateway.ts), so the limiter must count
    // it too: the first such credential is admitted, the second is refused.
    expect(limit(request('/v1/chat/completions', { authorization: 'Bearer fake one' }))).toBeNull();
    expect(
      limit(request('/v1/chat/completions', { authorization: 'Bearer fake two' }))?.status,
    ).toBe(429);
  });

  test('the charged-shared set is capped: a flood cannot grow it without bound', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000);
    for (let i = 0; i < 50_001; i++) limit(fake(i));
    expect(limit.chargedCount()).toBe(50_000);
  });

  test('a flood of rotating source addresses never resets the shared allowance', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000, 10);
    // 50 001 distinct sources: in a shared map this evicts the shared bucket
    // (created first) and re-creates it full, renewing the flood bound forever.
    let admitted = 0;
    for (let i = 0; i < 50_001; i++) {
      const r = new Request('https://gateway.test/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer kortix_fake_${i}`,
          'cf-connecting-ip': `10.0.${Math.floor(i / 256) % 256}.${i % 256}`,
        },
        body: '{"model":"x","messages":[]}',
      });
      if (limit(r, new Headers(), `10.0.${Math.floor(i / 256) % 256}.${i % 256}`) === null)
        admitted++;
    }
    // The shared allowance is 10/min; a reset would admit far more.
    expect(admitted).toBeLessThanOrEqual(12);
  });

  test('turning the edge trust off skips the per-source share: the shared allowance alone applies', () => {
    setSystemTime(new Date('2026-11-02T12:00:00Z'));
    const limit = createTokenRateLimit(1_000_000, 10, { trustEdgeClientIp: false });
    let admitted = 0;
    for (let i = 0; i < 20; i++)
      admitted += limit(fake(i), new Headers(), '10.0.0.1') === null ? 1 : 0;
    // One source at 1% of a 10-per-minute allowance would admit 1; with the
    // share skipped, the shared 10 apply.
    expect(admitted).toBe(10);
  });

  test('eleven concurrent first contacts of distinct credentials all admit (KRTX-4608 review)', () => {
    const limit = createTokenRateLimit(600, 10_000);
    // A boot burst arrives together: eleven distinct credentials, one caller
    // each, before any validation callback. The source is the edge's socket
    // peer — many unrelated callers share it — so the share is admission
    // capacity and must admit the burst the base admitted, not cap it at ten.
    for (let i = 0; i < 11; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      expect(
        limit(request('/v1/models', { authorization: `Bearer kortix_boot_${i}` }), new Headers(), '10.0.0.1'),
      ).toBeNull();
    }
  });

  test('a credential its own allowance refuses never spends its source\'s shared slots (KRTX-4608 review)', () => {
    const limit = createTokenRateLimit(600, 10_000);
    // Twenty first contacts exhaust the credential's own allowance; every
    // repeat inside the window is refused at that check, before the source is
    // read (the allowance refills at its own 20/min rate afterwards — the cap
    // is a rate, and the hammer's repeats never exceed it).
    const hammer = request('/v1/models', { authorization: 'Bearer kortix_hammer' });
    for (let i = 0; i < 20; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      expect(limit(hammer, new Headers(), '10.0.0.1')).toBeNull();
    }
    for (let i = 0; i < 10; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (20 + i) * 50));
      expect(limit(hammer, new Headers(), '10.0.0.1')?.status).toBe(429);
    }
    // The refused repeats spent nothing of the source's share: the other
    // callers behind the same edge keep the capacity the hammer never owned —
    // the share holds its remainder (100 minus the hammer's 20), so fifty
    // newcomers fit. Had every refused repeat charged the source, the fourth
    // would already be refused.
    for (let i = 0; i < 50; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (200 + i) * 50));
      expect(
        limit(request('/v1/models', { authorization: `Bearer kortix_legit_${i}` }), new Headers(), '10.0.0.1'),
      ).toBeNull();
    }
  });

  test('eleven concurrent first contacts of one cold credential all admit (KRTX-4608 review)', () => {
    const limit = createTokenRateLimit(600, 10_000);
    // A legitimate cold credential's own burst arrives together and every
    // request is still waiting on its validation callback: none of the eleven
    // may be refused before the API has vouched for any of them (the review's
    // cold-burst probe — base admitted all eleven, the 10/min cap did not).
    for (let i = 0; i < 11; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      expect(
        limit(request('/v1/models', { authorization: 'Bearer kortix_cold_burst' }), new Headers(), '10.0.0.1'),
      ).toBeNull();
    }
  });

  test('every pre-validation charge of one credential refunds its source slot at validation (KRTX-4608 review)', () => {
    // unvalidated 1 000/min puts the per-source share at its 1% fraction
    // (10/min), small enough for one credential's charges to exhaust it.
    const limit = createTokenRateLimit(600, 1_000);
    // A booting credential's first contacts arrive together: each spends a
    // source slot before the API has validated anything.
    for (let i = 0; i < 10; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      expect(
        limit(request('/v1/models', { authorization: 'Bearer kortix_booting' }), new Headers(), '10.0.0.1'),
      ).toBeNull();
    }
    // The share is spent: a new credential's first contact is refused.
    const newcomer = request('/v1/models', { authorization: 'Bearer kortix_newcomer' });
    expect(limit(newcomer, new Headers(), '10.0.0.1')?.status).toBe(429);
    // The API validates the booting credential: every charge refunds, so the
    // share is whole again and the following legitimate first contacts fit.
    limit.validated('kortix_booting');
    for (let i = 0; i < 10; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (100 + i) * 50));
      expect(
        limit(request('/v1/models', { authorization: `Bearer kortix_new_${i}` }), new Headers(), '10.0.0.1'),
      ).toBeNull();
    }
  });

  test('charges from distinct sources each refund their own source (KRTX-4608 review)', () => {
    const limit = createTokenRateLimit(600, 1_000);
    // The same credential's first contacts arrive through different edge hops:
    // three charges at each of two sources.
    for (let i = 0; i < 3; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      expect(
        limit(request('/v1/models', { authorization: 'Bearer kortix_booting' }), new Headers(), '10.0.0.1'),
      ).toBeNull();
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (i + 3) * 50));
      expect(
        limit(request('/v1/models', { authorization: 'Bearer kortix_booting' }), new Headers(), '10.0.0.2'),
      ).toBeNull();
    }
    limit.validated('kortix_booting');
    // Every source's own slots come back: each admits a full share again.
    for (let i = 0; i < 10; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (100 + i) * 50));
      expect(
        limit(request('/v1/models', { authorization: `Bearer kortix_new_${i}` }), new Headers(), '10.0.0.1'),
      ).toBeNull();
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + (200 + i) * 50));
      expect(
        limit(request('/v1/models', { authorization: `Bearer kortix_new_b_${i}` }), new Headers(), '10.0.0.2'),
      ).toBeNull();
    }
  });

  test('a never-validated credential that proves real refunds its source slot too', () => {
    const limit = createTokenRateLimit(600, 1_000);
    // Spend the per-source share with never-validated credentials, at network
    // pace (the clock moves 50ms per request — a real client's round trip).
    let lastAdmitted = '';
    for (let i = 0; i < 30; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      const credential = `kortix_unproven_${i}`;
      const headers = new Headers();
      if (limit(request('/v1/models', { authorization: `Bearer ${credential}` }), headers, '10.0.0.1') === null)
        lastAdmitted = credential;
    }
    expect(lastAdmitted).not.toBe('');
    // The share is spent: the next first contact is refused.
    const next = request('/v1/models', { authorization: 'Bearer kortix_unproven_next' });
    expect(limit(next, new Headers(), '10.0.0.1')?.status).toBe(429);
    // The API answered the last admitted credential with a principal. Its
    // source slot comes back, so the next first contact fits: the share
    // bounds never-validated push, not credentials the API has vouched for.
    limit.validated(lastAdmitted);
    expect(limit(next, new Headers(), '10.0.0.1')).toBeNull();
  });
});

describe('the unvalidated surface advertises the allowance that enforces it (KRTX-4608)', () => {
  // The pentest probe (ratelimit/counter-inert) sent 8 metered requests on one
  // bearer and read ratelimit-remaining 9999 of 10000 every time: the shared
  // pool refills ~166 tokens/s, faster than any honest client spends, so the
  // advertised counter never moved and the 429 path was unreachable.
  test('successive unvalidated requests advertise a remaining count that moves', () => {
    const limit = createTokenRateLimit(600, 10_000);
    const remaining: number[] = [];
    // Network pace: 50ms between sends, a real client's round trip. A refill
    // faster than that hides every spend.
    for (let i = 0; i < 8; i++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + i * 50));
      const headers = new Headers();
      expect(
        limit(request('/v1/models', { authorization: 'Bearer kortix_unproven' }), headers, '10.0.0.1'),
      ).toBeNull();
      remaining.push(Number(headers.get('RateLimit-Remaining')));
      if (i === 0) expect(headers.get('RateLimit-Limit')).toBe('20');
    }
    for (let i = 1; i < remaining.length; i++)
      expect(remaining[i]).toBeLessThan(remaining[i - 1]);
  });

  test('a credential its own allowance refused fits again at validation (KRTX-4608)', () => {
    const limit = createTokenRateLimit(600, 10_000);
    // The credential's own allowance drains and refuses it — the counter the
    // client watches govern this caller and no one else.
    let refused: Response | null = null;
    for (let sent = 0; sent < 25 && !refused; sent++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + sent * 50));
      refused = limit(
        request('/v1/models', { authorization: 'Bearer kortix_unproven' }),
        new Headers(),
        '10.0.0.1',
      );
    }
    expect(refused?.status).toBe(429);
    // The API vouches for the credential: it moves onto its own budget, and
    // nothing of the spent pre-validation allowance follows it there.
    limit.validated('kortix_unproven');
    expect(
      limit(request('/v1/models', { authorization: 'Bearer kortix_unproven' }), new Headers(), '10.0.0.1'),
    ).toBeNull();
  });

  test('a bounded burst exhausts the advertised allowance into a 429', () => {
    const limit = createTokenRateLimit(600, 10_000);
    let refused: Response | null = null;
    for (let sent = 0; sent < 25 && !refused; sent++) {
      setSystemTime(new Date(Date.parse('2026-11-02T12:00:00Z') + sent * 50));
      refused = limit(
        request('/v1/models', { authorization: 'Bearer kortix_unproven' }),
        new Headers(),
        '10.0.0.1',
      );
    }
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBeTruthy();
    expect(refused?.headers.get('RateLimit-Remaining')).toBe('0');
  });
});
