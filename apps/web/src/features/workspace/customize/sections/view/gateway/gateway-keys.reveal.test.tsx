import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { GatewayFirstRequest, firstRequestSamples } from '@kortix/ui/customize/sections/view/gateway/gateway-api-reference';

/** Paper KM01: the show-once reveal with one first-request card. */
describe('Gateway key reveal — KM01', () => {
  test('samples read the key from DOSCO_GATEWAY_KEY and never inline it', () => {
    const samples = firstRequestSamples('https://gateway.example.test');
    expect(samples.curl.code).toContain('Bearer $DOSCO_GATEWAY_KEY');
    expect(samples.python.code).toContain('os.environ["DOSCO_GATEWAY_KEY"]');
    expect(samples.node.code).toContain('process.env.DOSCO_GATEWAY_KEY');
    for (const sample of Object.values(samples)) {
      expect(sample.code).toContain('https://gateway.example.test/v1');
      expect(sample.code).not.toContain('dosco_gw_');
    }
  });

  test('the card: curl / Python / Node, POST endpoint, line numbers, labelled Copy', () => {
    const out = renderToStaticMarkup(<GatewayFirstRequest gatewayUrl={null} />);
    expect(out).toContain('Make your first request');
    expect(out).toContain('>curl<');
    expect(out).toContain('>Python<');
    expect(out).toContain('>Node<');
    expect(out).toContain('/v1/chat/completions');
    expect(out).toContain('Copy');
    // A gutter row per line of the curl sample.
    const curlLines = firstRequestSamples(null).curl.code.split('\n').length;
    expect(out).toContain(`<span>${curlLines}</span>`);
    // Markdown-style footnote: the env var and base URL as inline code chips.
    expect(out).toMatch(/<code[^>]*>DOSCO_GATEWAY_KEY<\/code>/);
    expect(out).toMatch(/<code[^>]*>https:\/\/gateway\.dosco\.live\/v1<\/code>/);
  });
});
