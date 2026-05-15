import { afterEach, describe, expect, test } from 'bun:test'
import { preconnectAnthropicApi } from './apiPreconnect.js'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_OPENCODE_GO: process.env.CLAUDE_CODE_USE_OPENCODE_GO,
  CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL,
}
const originalFetch = globalThis.fetch

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
})
