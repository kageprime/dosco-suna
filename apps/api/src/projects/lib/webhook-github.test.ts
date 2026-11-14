import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { githubNativeDelivery, verifyGithubWebhookSignature } from './trigger-webhook-auth';
import { webhookDeliveryKey } from './webhook-delivery';

// GitHub signs the raw body alone (X-Hub-Signature-256) and sends no
// X-Kortix-Timestamp, so a repository webhook could never fire a trigger.
// A GitHub-signed delivery verifies on the body, and its key is the
// signature itself: a captured delivery runs once, ever (KRTX-4098 holds).
const secret = 'synthetic-secret';
const body = '{"action":"labeled","issue":{"number":1}}';
const sign = (payload: string, key = secret) => `sha256=${createHmac('sha256', key).update(payload).digest('hex')}`;
const headers = (h: Record<string, string>) => (name: string) => h[name];
const github = { 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sign(body) };

describe('GitHub-native webhook delivery', () => {
  test('only X-Hub-Signature-256 + X-GitHub-Event + X-GitHub-Delivery without a Kortix timestamp is GitHub-native', () => {
    expect(githubNativeDelivery(headers(github))).toBe(true);
    expect(githubNativeDelivery(headers({ ...github, 'x-kortix-timestamp': '1' }))).toBe(false);
    expect(githubNativeDelivery(headers({ ...github, 'x-kortix-signature': sign(body) }))).toBe(false);
    const { 'x-github-event': _e, ...noEvent } = github;
    expect(githubNativeDelivery(headers(noEvent))).toBe(false);
    const { 'x-github-delivery': _d, ...noDelivery } = github;
    expect(githubNativeDelivery(headers(noDelivery))).toBe(false);
  });

  test('the body signature verifies; a wrong secret, a changed body or a malformed header does not', () => {
    expect(verifyGithubWebhookSignature(body, secret, sign(body))).toBe(true);
    expect(verifyGithubWebhookSignature(body, secret, sign(body, 'wrong'))).toBe(false);
    expect(verifyGithubWebhookSignature(`${body} `, secret, sign(body))).toBe(false);
    expect(verifyGithubWebhookSignature(body, secret, 'sha256=zz')).toBe(false);
    expect(verifyGithubWebhookSignature(body, secret, null)).toBe(false);
  });

  test('the key is the signature, not the sender-chosen delivery id, so a replay with a new id is the same delivery', () => {
    const base = { projectId: 'p1', slug: 'issues', rawBody: body, signatureHeader: sign(body), staticAuthFingerprint: '', githubNative: true };
    const first = webhookDeliveryKey({ ...base, header: headers(github) });
    const replay = webhookDeliveryKey({ ...base, header: headers({ ...github, 'x-github-delivery': 'forged-2' }) });
    expect(first.key).toBe(replay.key);
    expect(first.key).toMatch(/^trigger:webhook:p1:issues:github-sig:[0-9a-f]{64}$/);
    expect(first.permanent).toBe(true);
  });
});
