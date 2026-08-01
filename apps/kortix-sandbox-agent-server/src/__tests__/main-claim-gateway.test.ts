import { describe, expect, test } from 'bun:test'

import { pruneGatewayProxyEnv } from '../main'

describe('pruneGatewayProxyEnv — warm-pool claim env for gateway-off sessions', () => {
  test('drops KORTIX_LLM_PROXY_URL when the session has no gateway key', () => {
    const env = {
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_SANDBOX_TOKEN: 'sb-tok',
      KORTIX_API_URL: 'https://api.kortix.test/v1',
    }
    pruneGatewayProxyEnv(env)
    expect(env.KORTIX_LLM_PROXY_URL).toBeUndefined()
  })

  test('keeps KORTIX_LLM_PROXY_URL when the session carries a gateway key', () => {
    const env = {
      KORTIX_LLM_PROXY_URL: 'http://127.0.0.1:4319',
      KORTIX_LLM_API_KEY: 'pat-tok',
      KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
    }
    pruneGatewayProxyEnv(env)
    expect(env.KORTIX_LLM_PROXY_URL).toBe('http://127.0.0.1:4319')
  })

  test('keeps everything else untouched', () => {
    const env = { KORTIX_SANDBOX_TOKEN: 'sb-tok', KORTIX_API_URL: 'https://api.kortix.test/v1' }
    pruneGatewayProxyEnv(env)
    expect(env).toEqual({ KORTIX_SANDBOX_TOKEN: 'sb-tok', KORTIX_API_URL: 'https://api.kortix.test/v1' })
  })
})
