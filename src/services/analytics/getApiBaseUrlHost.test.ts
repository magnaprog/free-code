/**
 * Verify `getApiBaseUrlHost` (used as a GrowthBook user attribute for
 * enterprise-proxy targeting) returns `undefined` for canonical prod
 * variants and the actual host for non-prod base URLs. Aligned with the
 * `isHttpsAnthropicApiBaseUrl` gate semantics from round 16: trim env,
 * require https + default port + canonical hostname + no userinfo for
 * the "this is prod, no attribute" branch.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { getApiBaseUrlHost } from './growthbook.js'

const originalEnv = {
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getApiBaseUrlHost', () => {
  test('returns undefined when unset or blank', () => {
    delete process.env.ANTHROPIC_BASE_URL
    expect(getApiBaseUrlHost()).toBeUndefined()
    process.env.ANTHROPIC_BASE_URL = '   '
    expect(getApiBaseUrlHost()).toBeUndefined()
  })

  test('returns undefined for canonical prod variants', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(getApiBaseUrlHost()).toBeUndefined()
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com:443'
    expect(getApiBaseUrlHost()).toBeUndefined()
    process.env.ANTHROPIC_BASE_URL = '  https://api.anthropic.com  '
    expect(getApiBaseUrlHost()).toBeUndefined()
  })

  test('labels non-prod hosts for GrowthBook targeting', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://proxy.example.com'
    expect(getApiBaseUrlHost()).toBe('proxy.example.com')
    process.env.ANTHROPIC_BASE_URL = 'https://litellm.example.com:4000'
    expect(getApiBaseUrlHost()).toBe('litellm.example.com:4000')
  })

  test('treats insecure or non-default-port prod URLs as non-prod', () => {
    // Pre-fix code returned undefined for http:// api.anthropic.com because
    // `URL.host` is hostname only (default port :80 normalizes to empty).
    // Post-fix, the strict gate rejects it and the attribute is set so
    // GrowthBook can target/exclude that misconfiguration.
    process.env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com'
    expect(getApiBaseUrlHost()).toBe('api.anthropic.com')
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com:8443'
    expect(getApiBaseUrlHost()).toBe('api.anthropic.com:8443')
  })

  test('treats credential-bearing or spoof URLs as non-prod', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://user:pass@api.anthropic.com'
    expect(getApiBaseUrlHost()).toBe('api.anthropic.com')
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com@proxy.example'
    expect(getApiBaseUrlHost()).toBe('proxy.example')
  })

  test('returns undefined for malformed URLs', () => {
    process.env.ANTHROPIC_BASE_URL = 'not a url'
    expect(getApiBaseUrlHost()).toBeUndefined()
  })
})
