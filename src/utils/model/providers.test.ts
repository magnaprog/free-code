import { afterEach, describe, expect, test } from 'bun:test'
import { isFirstPartyAnthropicBaseUrl } from './providers.js'

const originalEnv = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  USER_TYPE: process.env.USER_TYPE,
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('isFirstPartyAnthropicBaseUrl', () => {
  test('treats unset or blank base URL as default first-party API', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)

    process.env.ANTHROPIC_BASE_URL = '   '
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('accepts production HTTPS Anthropic API with default port', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)

    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com:443'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('accepts staging only for ant users', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api-staging.anthropic.com'
    delete process.env.USER_TYPE
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.USER_TYPE = 'ant'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(true)
  })

  test('rejects insecure, custom, credential-bearing, and malformed URLs', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com:8443'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/anthropic'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com.evil.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com@proxy.example'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'https://user:pass@api.anthropic.com'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)

    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  })
})
