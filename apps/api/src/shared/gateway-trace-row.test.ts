import { describe, test, expect } from 'bun:test';
import { buildGatewayTraceRow, type GatewayTraceInput } from './gateway-trace-row';

// Built via fromCharCode so this test file stays pure ASCII: a literal NUL byte
// in source would make it a binary file.
const NUL = String.fromCharCode(0);
const NUL_JSON_ESCAPE = String.fromCharCode(92) + 'u0000';

function baseInput(overrides: Partial<GatewayTraceInput> = {}): GatewayTraceInput {
  return {
    requestId: 'req_1',
    accountId: 'acc_1',
    requestedModel: 'claude',
    resolvedModel: 'claude',
    provider: 'bedrock',
    status: 200,
    ok: true,
    ...overrides,
  };
}

describe('buildGatewayTraceRow', () => {
  test('strips NUL bytes from the request body (the column Postgres rejected)', () => {
    const row = buildGatewayTraceRow(
      baseInput({
        request: {
          messages: [{ role: 'system', content: `How you work${NUL} step 1` }],
        },
      }),
    );
    expect(JSON.stringify(row.request).includes(NUL_JSON_ESCAPE)).toBe(false);
    expect((row.request as any).messages[0].content).toBe('How you work step 1');
  });

  test('strips NUL bytes from response, metadata, candidatesTried, and errorMessage', () => {
    const row = buildGatewayTraceRow(
      baseInput({
        ok: false,
        errorMessage: `boom${NUL}`,
        candidatesTried: [`model${NUL}a`, 'model-b'],
        response: { output: `text${NUL}` },
        metadata: { note: `meta${NUL}data` },
      }),
    );
    const serialized = JSON.stringify(row);
    expect(serialized.includes(NUL_JSON_ESCAPE)).toBe(false);
    expect(row.errorMessage).toBe('boom');
    expect(row.candidatesTried).toEqual(['modela', 'model-b']);
    expect((row.response as any).output).toBe('text');
    expect((row.metadata as any).note).toBe('metadata');
  });

  test('wraps a non-object request payload under `value` and still scrubs it', () => {
    const row = buildGatewayTraceRow(baseInput({ request: `raw${NUL}body` }));
    expect(row.request).toEqual({ value: 'rawbody' });
  });

  test('null request/response become null; metadata defaults to {}', () => {
    const row = buildGatewayTraceRow(baseInput());
    expect(row.request).toBeNull();
    expect(row.response).toBeNull();
    expect(row.metadata).toEqual({});
    expect(row.candidatesTried).toEqual([]);
  });

  test('clean payloads pass through unchanged', () => {
    const request = { messages: [{ role: 'user', content: 'hi' }] };
    const row = buildGatewayTraceRow(baseInput({ request }));
    expect(row.request).toEqual(request);
  });

  // KRTX-4023: the dashboard aggregates read served_model / usage_estimated
  // as real columns (a jsonb expression cannot join the covering indexes'
  // INCLUDE lists) — the writer must lift the metadata keys into them.
  test('lifts the servedModel and usageEstimated metadata keys into columns', () => {
    const row = buildGatewayTraceRow(
      baseInput({ metadata: { servedModel: 'gpt-6.1-sol', usageEstimated: true } }),
    );
    expect(row.servedModel).toBe('gpt-6.1-sol');
    expect(row.usageEstimated).toBe(true);
  });

  test('an explicit false flag reads false; a missing key reads null (the pre-promotion shape)', () => {
    const explicit = buildGatewayTraceRow(baseInput({ metadata: { usageEstimated: false } }));
    expect(explicit.usageEstimated).toBe(false);
    expect(explicit.servedModel).toBeNull();

    const absent = buildGatewayTraceRow(baseInput());
    expect(absent.servedModel).toBeNull();
    expect(absent.usageEstimated).toBe(false);
  });

  // A served model id can carry a NUL only through a hostile upstream id: the
  // column is `text`, Postgres rejects U+0000 with 22021, and the trace write
  // is best-effort — an unscrubbed NUL drops the trace on every such request.
  test('strips NUL bytes from the servedModel metadata key when lifting it into the column', () => {
    const row = buildGatewayTraceRow(baseInput({ metadata: { servedModel: `gpt-6.1${NUL}-sol` } }));
    expect(row.servedModel).toBe('gpt-6.1-sol');
    expect(row.metadata?.servedModel).toBe('gpt-6.1-sol');
  });

  test('a non-string servedModel value never reaches the column', () => {
    const row = buildGatewayTraceRow(
      baseInput({ metadata: { servedModel: 42, usageEstimated: 'yes' } }),
    );
    expect(row.servedModel).toBeNull();
    // The SQL flag is the strict boolean the emit writes; a stray string is
    // not a trusted 'true'.
    expect(row.usageEstimated).toBe(false);
  });

  // Strix CWE-1284: the covering index's INCLUDE list carries the model
  // strings as btree tuple members (max ~2.7 KB). A client-supplied model
  // name of incompressible text must not be able to reject the whole trace
  // insert (the write is fire-and-forget: a rejection silently drops the
  // usage/budget row). Bound every model string at the single write site —
  // BYTES, not code points: 255 astral code points are up to 1020 UTF-8
  // bytes and the tuple would still overflow.
  test('bounds the client-supplied model strings to 255 bytes (the covering-index tuple guard)', () => {
    const huge = 'X'.repeat(10_000);
    const rockets = '🚀'.repeat(300); // 300 code points = 1200 UTF-8 bytes
    const row = buildGatewayTraceRow(
      baseInput({
        requestedModel: huge,
        resolvedModel: rockets,
        metadata: { servedModel: `a\u0000${huge}` },
      }),
    );
    expect(Buffer.byteLength(row.requestedModel, 'utf8')).toBe(255);
    expect(Buffer.byteLength(row.resolvedModel, 'utf8')).toBe(252); // 63 × 4B; the 64th rocket would exceed
    expect(Array.from(row.resolvedModel)).toHaveLength(63); // whole code points, never a split surrogate
    expect(row.servedModel).toBe(`a${'X'.repeat(254)}`); // NUL stripped, then bounded
  });

  // G9 round 2: the maximal byte-safe prefix, not an average-width cut — a
  // string of 255 ASCII bytes followed by astral chars keeps every one of
  // its 255 ASCII bytes (the helper in the DB must return the identical
  // prefix for the same input).
  test('mixed-width strings keep their full byte budget (maximal prefix, not an average cut)', () => {
    const mixed = 'X'.repeat(255) + '🚀'.repeat(300);
    const row = buildGatewayTraceRow(baseInput({ requestedModel: mixed }));
    expect(row.requestedModel).toBe('X'.repeat(255));
    expect(Buffer.byteLength(row.requestedModel, 'utf8')).toBe(255);
  });
});

describe('buildGatewayTraceRow metadata bound (KRTX-4022)', () => {
  // metadata rode a btree tuple while a covering index carried it (v2/v3,
  // max ~2.7 KB); v4 promoted the two read keys out and no index carries
  // metadata anymore — the bound stays as the row-width guard (the jsonb
  // column is unbounded and the logs page reads it per row).
  const BOUND = 2000;
  const failure = (attempt: number, message: string) => ({
    attempt,
    provider: 'openai',
    routeModel: 'gpt-6.1-sol',
    resolvedModel: 'gpt-6.1-sol',
    stage: 'dispatch',
    status: 502,
    code: 502,
    message,
  });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

  test('multi-attempt failures with huge upstream messages stay under the index-tuple bound', () => {
    const attemptFailures = Array.from({ length: 6 }, (_, i) => failure(i + 1, `${i}`.repeat(20_000)));
    const row = buildGatewayTraceRow(baseInput({ metadata: { usageEstimated: false, servedModel: 'm', attemptFailures } }));
    expect(bytes(row.metadata)).toBeLessThanOrEqual(BOUND);
    const kept = (row.metadata as any).attemptFailures;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]).toMatchObject({ attempt: 1, provider: 'openai', status: 502, code: 502 });
    expect((row.metadata as any).usageEstimated).toBe(false);
    expect((row.metadata as any).servedModel).toBe('m');
  });

  test('multi-byte text is bounded by bytes, not characters', () => {
    const attemptFailures = [failure(1, '\u{1F600}'.repeat(5000))];
    const row = buildGatewayTraceRow(baseInput({ metadata: { attemptFailures } }));
    expect(bytes(row.metadata)).toBeLessThanOrEqual(BOUND);
  });

  test('metadata already under the bound is stored untouched', () => {
    const metadata = { usageEstimated: true, attemptFailures: [failure(1, 'upstream said no')] };
    expect(buildGatewayTraceRow(baseInput({ metadata })).metadata).toEqual(metadata);
  });
});
