/** The ChatGPT device-code start tells an OpenAI outage apart from a refusal (KRTX-5014). */
import { afterEach, describe, expect, test } from 'bun:test';
import { DeviceAuthUnavailableError } from '../llm-gateway/credentials/codex-core';
import { startCodexDeviceAuth } from './codex-device-auth';

const realFetch = globalThis.fetch;
const answer = (status: number, body: unknown = {}) => {
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify(body), { status }), { preconnect: realFetch.preconnect });
};
afterEach(() => { globalThis.fetch = realFetch; });

describe('startCodexDeviceAuth', () => {
  test.each([500, 502, 503, 504])('an OpenAI %i is a DeviceAuthUnavailableError', async (status) => {
    answer(status);
    const failure = await startCodexDeviceAuth().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(DeviceAuthUnavailableError);
    expect(failure).toHaveProperty('message', 'ChatGPT sign-in is temporarily unavailable. Try again in a moment.');
  });

  test.each([400, 403, 429])('an OpenAI %i stays a plain failure with its status', async (status) => {
    answer(status);
    const failure = await startCodexDeviceAuth().catch((err: unknown) => err);
    expect(failure).not.toBeInstanceOf(DeviceAuthUnavailableError);
    expect(failure).toHaveProperty('message', `Failed to start ChatGPT device authorization (${status})`);
  });

  test('a device code is the challenge', async () => {
    answer(200, { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5' });
    expect(await startCodexDeviceAuth()).toEqual({
      verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', deviceAuthId: 'dev-1', intervalMs: 5000,
    });
  });
});
