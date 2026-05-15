import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetPreconnectForTesting,
  preconnectAnthropicApi,
} from './apiPreconnect.js'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_OPENCODE_GO: process.env.CLAUDE_CODE_USE_OPENCODE_GO,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
}
const originalFetch = globalThis.fetch

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

  test('warms the explicit ANTHROPIC_BASE_URL on the first-party path', () => {
    // Clear any provider flag so getAPIProvider() returns 'firstParty'.
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_OPENCODE_GO
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

    let observedUrl: string | undefined
    globalThis.fetch = ((input: unknown) => {
      observedUrl = typeof input === 'string' ? input : String(input)
      return Promise.resolve(new Response(null, { status: 200 }))
    }) as typeof globalThis.fetch

    expect(() => preconnectAnthropicApi()).not.toThrow()
    expect(observedUrl).toBe('https://api.anthropic.com')
  })

  test('second call within a session is a no-op (fired latch)', () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_OPENCODE_GO
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

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
