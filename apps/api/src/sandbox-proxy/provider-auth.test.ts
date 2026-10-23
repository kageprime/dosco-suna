import { expect, test } from 'bun:test';
import { isProviderIngressAuthFailure } from './provider-auth';

test('keeps sandbox authentication and other providers separate from Daytona ingress authentication', async () => {
  // The observed Daytona ingress refusal is recognized...
  expect(
    await isProviderIngressAuthFailure(
      'daytona',
      Response.json(
        {
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'unauthorized: authentication failed: Invalid or expired token',
        },
        { status: 401 },
      ),
    ),
  ).toBe(true);
  // ...and its near misses are not.
  for (const body of [
    { error: 'unauthorized', reason: 'malformed' },
    { statusCode: 401, code: 'UNAUTHORIZED', message: 'application authorization failed' },
    null,
  ]) {
    expect(await isProviderIngressAuthFailure('daytona', Response.json(body, { status: 401 }))).toBe(false);
  }
  expect(await isProviderIngressAuthFailure('platinum', Response.json({
    statusCode: 401, code: 'UNAUTHORIZED', message: 'unauthorized: authentication failed: expired',
  }, { status: 401 }))).toBe(false);
});

test('recognizes an E2B traffic-token refusal, missing or invalid, whatever body shape the edge picked', async () => {
  const jsonMissing = Response.json(
    {
      message: "Sandbox is secured with traffic access token.\nToken header 'e2b-traffic-access-token' is missing",
      sandboxId: 'x7k2m9q4z6c1v0b8n5j3',
    },
    { status: 403 },
  );
  expect(await isProviderIngressAuthFailure('e2b', jsonMissing)).toBe(true);

  const jsonInvalid = Response.json(
    {
      message: "Sandbox is secured with traffic access token.\nProvided token in header 'e2b-traffic-access-token' is invalid",
      sandboxId: 'x7k2m9q4z6c1v0b8n5j3',
    },
    { status: 403 },
  );
  expect(await isProviderIngressAuthFailure('e2b', jsonInvalid)).toBe(true);

  // Browser-shaped requests get an HTML page whose copy rep phrases the same
  // sentences; the header name is the stable marker.
  const htmlMissing = new Response(
    '<h1>Missing traffic access token</h1><p>The sandbox x7k2m9q4z6c1v0b8n5j3 requires a traffic access token. The e2b-traffic-access-token header is missing.</p>',
    { status: 403, headers: { 'content-type': 'text/html' } },
  );
  expect(await isProviderIngressAuthFailure('e2b', htmlMissing)).toBe(true);

  // Every other E2B 403 stays an upstream body the proxy passes through.
  expect(await isProviderIngressAuthFailure('e2b', new Response(null, { status: 403 }))).toBe(false);
  expect(await isProviderIngressAuthFailure('e2b', new Response('forbidden', { status: 403 }))).toBe(false);
  expect(
    await isProviderIngressAuthFailure(
      'e2b',
      new Response(
        JSON.stringify({ message: "Token header 'e2b-traffic-access-token' is missing" }),
        { status: 500 },
      ),
    ),
  ).toBe(false);
});

test('the refusal check reads via a clone: a later consumer still gets the body', async () => {
  // retry.ts cancels the body after its own read; provider-auth must read via
  // a clone so a later consumer (respondFromUpstream on a
  // pass-through, or the JSON branch below) still gets bytes.
  const response = Response.json(
    { message: "Token header 'e2b-traffic-access-token' is missing" },
    { status: 403 },
  );
  expect(await isProviderIngressAuthFailure('e2b', response)).toBe(true);
  expect(await response.text()).toContain('e2b-traffic-access-token');
});

test('recognizes only the observed HTTPS Daytona login endpoint', async () => {
  expect(
    await isProviderIngressAuthFailure(
      'daytona',
      new Response(null, {
        status: 307,
        headers: { location: 'https://api.auth.daytona.io/user_management/authorize?state=x' },
      }),
    ),
  ).toBe(true);
  for (const location of [
    'https://api.auth.daytona.io.evil.test/user_management/authorize',
    'http://api.auth.daytona.io/user_management/authorize',
    'https://api.auth.daytona.io/application/oauth',
    '/user_management/authorize',
  ]) {
    expect(await isProviderIngressAuthFailure('daytona', new Response(null, {
      status: 307, headers: { location },
    }))).toBe(false);
  }
});
