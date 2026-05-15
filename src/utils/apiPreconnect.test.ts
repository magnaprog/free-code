import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetPreconnectForTesting,
  PRECONNECT_SKIP_ENV_KEYS,
  preconnectAnthropicApi,
} from './apiPreconnect.js'

const providerEnvKeys = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_OPENCODE_GO',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

const trackedEnvKeys = [
  ...providerEnvKeys,
  ...PRECONNECT_SKIP_ENV_KEYS,
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'ANTHROPIC_BASE_URL',
] as const

const originalEnv = Object.fromEntries(
  trackedEnvKeys.map(key => [key, process.env[key]]),
)
const originalFetch = globalThis.fetch

function clearEnv(keys: readonly string[]): void {
  for (const key of keys) delete process.env[key]
}

function useFirstPartyApiBaseUrl(): void {
  clearEnv(providerEnvKeys)
  clearEnv(PRECONNECT_SKIP_ENV_KEYS)
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
}

beforeEach(() => {
  // preconnect latches `fired = true` on first call. Reset before every
  // test so test order can't make a later assertion pass trivially.
  __resetPreconnectForTesting()
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  globalThis.fetch = originalFetch
})

describe('preconnectAnthropicApi', () => {
  test('pins the transport envs that disable preconnect warming', () => {
    expect(PRECONNECT_SKIP_ENV_KEYS).toEqual([
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'ANTHROPIC_UNIX_SOCKET',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
    ])
  })

  test('does not resolve OAuth config for non-first-party providers', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://not-allowlisted.example'

    let fetchCalled = false
    globalThis.fetch = (() => {
      fetchCalled = true
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch

    expect(() => preconnectAnthropicApi()).not.toThrow()
    expect(fetchCalled).toBe(false)
  })

  test('skips warming when proxy, unix socket, or mTLS env is configured', () => {
    for (const key of PRECONNECT_SKIP_ENV_KEYS) {
      __resetPreconnectForTesting()
      useFirstPartyApiBaseUrl()
      process.env[key] = key === 'ANTHROPIC_UNIX_SOCKET' ? '/tmp/x.sock' : '1'

      let fetchCalled = false
      globalThis.fetch = (() => {
        fetchCalled = true
        return Promise.resolve(new Response(null, { status: 200 }))
      }) as typeof globalThis.fetch

      preconnectAnthropicApi()
      expect(fetchCalled).toBe(false)
    }
  })

  test('warms the explicit ANTHROPIC_BASE_URL on the first-party path', () => {
    useFirstPartyApiBaseUrl()

    let observedUrl: string | undefined
    globalThis.fetch = ((input: unknown) => {
      observedUrl = typeof input === 'string' ? input : String(input)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch

    expect(() => preconnectAnthropicApi()).not.toThrow()
    expect(observedUrl).toBe('https://api.anthropic.com')
  })

  test('second call within a session is a no-op (fired latch)', () => {
    useFirstPartyApiBaseUrl()

    let fetchCallCount = 0
    globalThis.fetch = (() => {
      fetchCallCount += 1
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch

    preconnectAnthropicApi()
    preconnectAnthropicApi()
    expect(fetchCallCount).toBe(1)
  })
})
