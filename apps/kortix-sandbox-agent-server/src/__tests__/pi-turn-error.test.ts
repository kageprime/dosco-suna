import { describe, expect, test } from 'bun:test'
import { assistantMessageError } from '@/harness/pi/turn-events'
import { turnEndAfterBegin, turnErrorCode } from '@/harness/shared/turn-relay'

const failed = (errorMessage: string) => assistantMessageError({ stopReason: 'error', errorMessage })

describe('pi turn errors carry a TurnErrorCode', () => {
  test('a leading HTTP status becomes data.statusCode and the code', () => {
    expect(failed('402 Payment Required: Insufficient credits. Balance: $-0.06')).toEqual({
      name: 'UnknownError',
      data: { message: '402 Payment Required: Insufficient credits. Balance: $-0.06', statusCode: 402 },
      code: 'credits',
    })
    expect(failed('429: rate limited')?.code).toBe('rate_limit')
    expect(failed('401 {"error":"invalid api key"}')?.code).toBe('auth')
    expect(failed('403 forbidden')?.code).toBe('auth')
    expect(failed('500 upstream broke')).toMatchObject({ data: { statusCode: 500 }, code: 'unknown' })
  })

  // pi-ai writes the gateway's refusal as "<status>: <error JSON>" (formatProviderError).
  test('a gateway refusal fixed in Models is a ProviderAuthError naming the provider', () => {
    const notConnected = '400: {"message":"No anthropic API key is connected for this project.","type":"provider_not_connected","code":"provider_not_connected","provider":"","requested_model":"anthropic/claude-sonnet-4.6","resolved_model":"anthropic/claude-sonnet-4.6","suggestion":"Add a anthropic API key in project settings, then retry."}'
    expect(failed(notConnected)).toEqual({
      name: 'ProviderAuthError',
      data: { providerID: 'anthropic', message: notConnected },
      code: 'auth',
    })
    const rejected = '401: {"message":"invalid x-api-key","type":"invalid_request_error","code":"provider_key_rejected","provider":"anthropic"}'
    expect(failed(rejected)).toMatchObject({ name: 'ProviderAuthError', data: { providerID: 'anthropic' }, code: 'auth' })
    // A provider account out of funds is the provider's, not Kortix credits.
    const unfunded = '402: {"message":"This request requires more credits, or fewer max_tokens.","type":"invalid_request_error","code":"provider_payment_required","provider":"openrouter"}'
    expect(failed(unfunded)).toMatchObject({ name: 'ProviderAuthError', data: { providerID: 'openrouter' }, code: 'auth' })
    // No provider in the envelope: the turn's model names it.
    const bare = '401: {"message":"bad key","code":"provider_key_rejected"}'
    expect(assistantMessageError({ stopReason: 'error', errorMessage: bare, model: 'openai/gpt-5' }))
      .toMatchObject({ name: 'ProviderAuthError', data: { providerID: 'openai' } })
  })

  test('a pool at rest is rate_limit; the session token refusal stays auth by status, not a provider error', () => {
    expect(failed('429: {"message":"All selected openai keys are cooling down after rate limits.","code":"provider_pool_rate_limited","provider":"openai"}'))
      .toMatchObject({ name: 'UnknownError', data: { statusCode: 429 }, code: 'rate_limit' })
    expect(failed('400: {"message":"All openai keys are cooling down.","code":"provider_pool_rate_limited"}')?.code).toBe('rate_limit')
    expect(failed('401: {"message":"Invalid token","code":"invalid_token"}')).toMatchObject({ name: 'UnknownError', code: 'auth' })
  })

  test('a number that is not a leading status stays unknown', () => {
    expect(failed('Stream ended without finish_reason')).toEqual({
      name: 'UnknownError',
      data: { message: 'Stream ended without finish_reason' },
      code: 'unknown',
    })
    expect(failed('200 tokens left')?.code).toBe('unknown')
  })

  test('a context overflow is context_length', () => {
    expect(failed('prompt is too long: 213462 tokens > 200000 maximum')).toMatchObject({
      name: 'ContextOverflowError',
      code: 'context_length',
    })
  })

  test('aborted and length stops', () => {
    expect(assistantMessageError({ stopReason: 'aborted', errorMessage: undefined })).toEqual({
      name: 'MessageAbortedError',
      data: { message: 'The message was aborted' },
      code: 'aborted',
    })
    expect(assistantMessageError({ stopReason: 'length', errorMessage: undefined })).toEqual({
      name: 'MessageOutputLengthError',
      data: { message: 'The answer reached the model output limit and was cut off. Ask for the rest, or narrow the request.' },
      code: 'output_length',
    })
    expect(assistantMessageError({ stopReason: 'stop', errorMessage: undefined })).toBeUndefined()
  })

  test('the relay code for errors an adapter names itself', () => {
    expect(turnErrorCode({ name: 'ProviderAuthError' })).toBe('auth')
    expect(turnErrorCode({ name: 'APIError', statusCode: 429 })).toBe('rate_limit')
    expect(turnErrorCode({ name: 'RuntimeAbortedTurn' })).toBe('unknown')
    expect(turnErrorCode({ name: 'TimeoutError' })).toBe('unknown')
  })
})

describe('a pi turn end waits for its begin relay (turnEndAfterBegin)', () => {
  test('the end goes after the begin settles, however fast the turn ended', async () => {
    const order = turnEndAfterBegin()
    const sent: string[] = []
    let settle!: () => void
    order.begin('msg_a', new Promise<void>((resolve) => (settle = resolve)).then(() => void sent.push('begin')))
    const end = order.end('msg_a').then(() => void sent.push('end'))
    await Bun.sleep(20)
    expect(sent).toEqual([])
    settle()
    await end
    expect(sent).toEqual(['begin', 'end'])
  })

  test('a hung begin delays the end at most the bound', async () => {
    const order = turnEndAfterBegin(50)
    order.begin('msg_b', new Promise(() => {}))
    const t0 = Date.now()
    await order.end('msg_b')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45)
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  test('an end with no begin, or a second end, does not wait', async () => {
    const order = turnEndAfterBegin(10_000)
    order.begin('msg_c', new Promise(() => {}))
    const t0 = Date.now()
    await order.end('msg_none')
    void order.end('msg_c')
    await order.end('msg_c')
    expect(Date.now() - t0).toBeLessThan(500)
  })
})
