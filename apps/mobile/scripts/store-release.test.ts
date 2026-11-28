import { describe, expect, test } from 'bun:test';

import { compareVersions, describeError, main, releaseIos, fetchWithRetry, iosStep, pickBuild, run, shippedBuildIds } from './store-release.mjs';

const build = (id: string) => ({ id, appBuildVersion: id });

describe('store release decisions', () => {
  test('compares versions numerically, not as text', () => {
    expect(compareVersions('1.5.10', '1.5.9')).toBe(1);
    expect(compareVersions('1.5.5', '1.5.5')).toBe(0);
    expect(compareVersions('1.4.9', '1.5.0')).toBe(-1);
  });

  test('submits only a version nobody has sent to Apple', () => {
    expect(iosStep('PREPARE_FOR_SUBMISSION')).toBe('submit');
    expect(iosStep('READY_FOR_REVIEW')).toBe('submit');
  });

  test('never resubmits what Apple rejected or a person pulled from review', () => {
    for (const state of ['REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY', 'DEVELOPER_REJECTED']) {
      expect(iosStep(state)).toBe('blocked');
    }
  });

  test('releases an approved version held for a manual release', () => {
    expect(iosStep('PENDING_DEVELOPER_RELEASE')).toBe('release');
  });

  test('leaves a version alone while Apple has it or after it is live', () => {
    for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE', 'PROCESSING_FOR_DISTRIBUTION']) {
      expect(iosStep(state)).toBe('wait');
    }
    expect(iosStep('READY_FOR_DISTRIBUTION')).toBe('live');
    expect(iosStep('READY_FOR_SALE')).toBe('live');
  });
});

describe('only released code ships', () => {
  test('an Android build sent to internal testing is not shipped', () => {
    const subs = [
      { status: 'FINISHED', submittedBuild: { id: 'internal' }, androidConfig: { track: 'internal' } },
      { status: 'FINISHED', submittedBuild: { id: 'prod' }, androidConfig: { track: 'production' } },
      { status: 'ERRORED', submittedBuild: { id: 'failed' }, androidConfig: { track: 'production' } },
    ];
    expect([...shippedBuildIds(subs, 'android', 'production')]).toEqual(['prod']);
  });

  test('a newer build from unreleased code is ignored; the trusted one ships', () => {
    const picked = pickBuild({
      platform: 'android',
      builds: [build('rogue'), build('released')],
      shipped: new Set<string>(),
      trusted: (b: { id: string }) => b.id === 'released',
    });
    expect(picked.build?.id).toBe('released');
    expect(picked.ship).toBe(true);
    expect(picked.ignored.map((b: { id: string }) => b.id)).toEqual(['rogue']);
  });

  test('with no trusted build the run builds from the released commit', () => {
    const picked = pickBuild({ platform: 'ios', builds: [build('rogue')], shipped: new Set<string>(), trusted: () => false });
    expect(picked.build).toBeNull();
    expect(picked.ignored.map((b: { id: string }) => b.id)).toEqual(['rogue']);
  });

  test('an Android version already on the production track is never shipped twice', () => {
    const picked = pickBuild({ platform: 'android', builds: [build('14')], shipped: new Set(['14']), trusted: () => false });
    expect(picked.build?.id).toBe('14');
    expect(picked.ship).toBe(false);
  });

  test('App Review never gets an untrusted iOS upload', () => {
    const picked = pickBuild({
      platform: 'ios',
      builds: [build('uploaded-from-dev'), build('released')],
      shipped: new Set(['uploaded-from-dev']),
      trusted: (b: { id: string }) => b.id === 'released',
    });
    expect(picked.build?.id).toBe('released');
    expect(picked.ship).toBe(true);
  });
});

describe('store API calls survive one dropped connection', () => {
  const noWait = async () => {};

  test('retries a network error and returns the next response', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response('{}', { status: 200 });
    };
    const res = await fetchWithRetry('https://example.test', {}, { fetchFn, wait: noWait });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  test('retries 429 and 5xx, never another 4xx', async () => {
    const statuses = [503, 429, 200];
    const res = await fetchWithRetry('https://example.test', {}, {
      fetchFn: async () => new Response('', { status: statuses.shift() }),
      wait: noWait,
    });
    expect(res.status).toBe(200);

    let calls = 0;
    const conflict = await fetchWithRetry('https://example.test', {}, {
      fetchFn: async () => { calls += 1; return new Response('', { status: 409 }); },
      wait: noWait,
    });
    expect(conflict.status).toBe(409);
    expect(calls).toBe(1);
  });

  test('throws the last network error after the final attempt', async () => {
    let calls = 0;
    const fetchFn = async () => { calls += 1; throw new TypeError('fetch failed'); };
    await expect(fetchWithRetry('https://example.test', {}, { fetchFn, wait: noWait, attempts: 3 })).rejects.toThrow('fetch failed');
    expect(calls).toBe(3);
  });
});

// Exercise the Apple adapter, not a duplicated state classifier.
describe('App Store delivery gates', () => {
  const version = '1.0.10';
  const options = { projectId: 'synthetic-project', appId: 'synthetic-app', version, buildNumber: '10', dryRun: false };
  const apple = (state: string, v = version) => async (method: string) => {
    if (method !== 'GET') throw new Error(`manual gate was mutated: ${method}`);
    return { data: [{ id: 'synthetic-version', attributes: { versionString: v, appVersionState: state } }] };
  };

  test('a rejected iOS submission fails rather than silently succeeding', async () => {
    await expect(releaseIos(options, async () => apple('REJECTED'))).rejects.toThrow('REJECTED');
  });

  test('a higher Apple version identifies incomplete iOS delivery', async () => {
    await expect(releaseIos(options, async () => apple('PREPARE_FOR_SUBMISSION', '1.0.11'))).rejects.toThrow('higher version');
  });

  test('pending Apple review is explicit and is not a completed rollout', async () => {
    await expect(releaseIos(options, async () => apple('IN_REVIEW'))).resolves.toBeUndefined();
  });

  test('an editable version attaches its processed build and requests review, not rollout', async () => {
    const calls: string[] = [];
    const asc = async (method: string, path: string) => {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (path.startsWith('/v1/apps/')) return { data: [{ id: 'version', attributes: { versionString: version, appVersionState: 'PREPARE_FOR_SUBMISSION' } }] };
      if (path.startsWith('/v1/builds?')) return { data: [{ id: 'build', attributes: { processingState: 'VALID' } }] };
      if (method === 'GET') return { data: [] };
      if (path === '/v1/reviewSubmissions' && method === 'POST') return { data: { id: 'review' } };
      return { data: {} };
    };
    await releaseIos(options, async () => asc);
    expect(calls).toContain('PATCH /v1/appStoreVersions/version/relationships/build');
    expect(calls).toContain('POST /v1/reviewSubmissionItems');
    expect(calls.at(-1)).toBe('PATCH /v1/reviewSubmissions/review');
    expect(calls.some((call) => call.includes('ReleaseRequests'))).toBe(false);
  });

  for (const existing of ['target', 'draft', 'new']) {
    for (const releaseType of ['MANUAL', 'SCHEDULED', 'AFTER_APPROVAL']) {
      test(`${existing} version preserves ${releaseType} policy through review submission`, async () => {
        const attributes = {
          versionString: existing === 'draft' ? '1.0.9' : version,
          appVersionState: 'PREPARE_FOR_SUBMISSION',
          releaseType,
          earliestReleaseDate: '2030-01-01T00:00:00Z',
        };
        const writes: { method: string; path: string; body: { data: { attributes?: Record<string, unknown> } } }[] = [];
        const asc = async (method: string, path: string, body: { data: { attributes?: Record<string, unknown> } }) => {
          if (method !== 'GET') writes.push({ method, path, body });
          if (path.startsWith('/v1/apps/')) return { data: existing === 'new' ? [] : [{ id: 'version', attributes }] };
          if (path.startsWith('/v1/builds?')) return { data: [{ id: 'build', attributes: { processingState: 'VALID' } }] };
          if (method === 'GET') return { data: [] };
          if (path === '/v1/appStoreVersions' || path === '/v1/appStoreVersions/version') {
            Object.assign(attributes, body.data.attributes);
            return { data: { id: 'version', attributes } };
          }
          if (path === '/v1/reviewSubmissions') return { data: { id: 'review' } };
          return { data: {} };
        };
        await releaseIos(options, async () => asc);
        expect(attributes.releaseType).toBe(existing === 'new' ? 'AFTER_APPROVAL' : releaseType);
        expect(attributes.earliestReleaseDate).toBe('2030-01-01T00:00:00Z');
        const versionWrites = writes.filter(({ path }) => path === '/v1/appStoreVersions/version');
        expect(versionWrites.map(({ body }) => body.data.attributes)).toEqual(existing === 'draft' ? [{ versionString: version }] : []);
        expect(writes.at(-1)?.body.data.attributes).toEqual({ submitted: true });
      });
    }
  }

  test('an approved manual release is preserved, not released by automation', async () => {
    await expect(releaseIos(options, async () => apple('PENDING_DEVELOPER_RELEASE'))).rejects.toThrow('manual release');
  });

  // Apple answers 409 "You cannot create a new version of the App in the
  // current state" while it still has an older version.
  for (const state of ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'PENDING_APPLE_RELEASE']) {
    test(`a new version waits, unwritten, while Apple has the older one ${state}`, async () => {
      await expect(releaseIos(options, async () => apple(state, '1.0.9'))).resolves.toBeUndefined();
    });
  }

  test('a new version behind an older one held for manual release needs a person', async () => {
    await expect(releaseIos(options, async () => apple('PENDING_DEVELOPER_RELEASE', '1.0.9'))).rejects.toThrow('release it in App Store Connect');
  });

  test('an older live version does not hold the new one back', async () => {
    const writes: string[] = [];
    const asc = async (method: string, path: string) => {
      if (method !== 'GET') writes.push(`${method} ${path.split('?')[0]}`);
      if (path.startsWith('/v1/apps/')) return { data: [{ id: 'old', attributes: { versionString: '1.0.9', appVersionState: 'READY_FOR_DISTRIBUTION' } }] };
      if (path.startsWith('/v1/builds?')) return { data: [{ id: 'build', attributes: { processingState: 'VALID' } }] };
      if (method === 'GET') return { data: [] };
      if (path === '/v1/appStoreVersions') return { data: { id: 'new', attributes: { versionString: version, releaseType: 'AFTER_APPROVAL' } } };
      if (path === '/v1/reviewSubmissions') return { data: { id: 'review' } };
      return { data: {} };
    };
    await releaseIos(options, async () => asc);
    expect(writes[0]).toBe('POST /v1/appStoreVersions');
    expect(writes.at(-1)).toBe('PATCH /v1/reviewSubmissions/review');
  });
});

describe('a long EAS command keeps the event loop running', () => {
  test('timers fire while run() waits, and it returns stdout', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 50);
    try {
      const out = await run('sh', ['-c', 'sleep 0.5; echo done']);
      expect(out.trim()).toBe('done');
      // execFileSync would leave this at 0: fetch's idle timer could not run either.
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(timer);
    }
  });

  test('a failing command rejects with its exit code', async () => {
    await expect(run('sh', ['-c', 'exit 3'])).rejects.toThrow('exited with 3');
  });
});

describe('a failed release names the network error', () => {
  test('describeError reports the cause fetch hides behind "fetch failed"', () => {
    const perAddress = Object.assign(new AggregateError([
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT', address: '192.0.2.1' }),
      Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH', address: '2001:db8::1' }),
    ], ''), { code: 'ETIMEDOUT' });
    const error = new TypeError('fetch failed', { cause: perAddress });
    expect(describeError(error)).toBe('fetch failed <- ETIMEDOUT [ETIMEDOUT 192.0.2.1, ENETUNREACH 2001:db8::1]');
    expect(describeError(new Error('plain'))).toBe('plain');
  });
});


describe('both-platform orchestration', () => {
  test('Android still submits after iOS fails, and the run fails', async () => {
    const previous = process.env.EXPO_TOKEN;
    process.env.EXPO_TOKEN = 'synthetic-token';
    const reached: string[] = [];
    try {
      await expect(main({
        release: async ({ platform }: { platform: string }) => {
          reached.push(platform);
          if (platform === 'ios') throw new Error('synthetic iOS submission failed');
        },
        notify: async () => {},
      })).rejects.toThrow('delivery incomplete');
      expect(reached).toEqual(['ios', 'android']);
    } finally {
      if (previous === undefined) delete process.env.EXPO_TOKEN;
      else process.env.EXPO_TOKEN = previous;
    }
  });
});
