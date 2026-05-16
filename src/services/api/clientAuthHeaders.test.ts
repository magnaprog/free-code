/**
 * Verify the auth-header strip utility removes case-variants of
 * Authorization and X-Api-Key from inherited headers. Used by the
 * OpenCode anthropic_messages branch in client.ts so a stray Anthropic
 * credential from ANTHROPIC_CUSTOM_HEADERS, configureApiKeyHeaders, or
 * the api-key helper does not leak to the OpenCode gateway via the SDK
 * header right-merge.
 */
import { describe, expect, test } from 'bun:test'
import {
  createFoundrySkipAuthFetch,
  NON_DIRECT_ENV_AUTH_SUPPRESSION,
  NON_DIRECT_ENV_BEARER_SUPPRESSION,
  routesToProdAnthropicAPI,
  stripInheritedAuthHeaders,
} from './client.js'

describe('stripInheritedAuthHeaders contract', () => {
  test('removes Authorization regardless of case', () => {
    expect(stripInheritedAuthHeaders({ Authorization: 'Bearer x' })).toEqual({})
    expect(stripInheritedAuthHeaders({ authorization: 'Bearer x' })).toEqual({})
    expect(stripInheritedAuthHeaders({ AUTHORIZATION: 'Bearer x' })).toEqual({})
    expect(stripInheritedAuthHeaders({ AuthorizatioN: 'Bearer x' })).toEqual({})
  })

  test('removes X-Api-Key regardless of case', () => {
    expect(stripInheritedAuthHeaders({ 'X-Api-Key': 'sk-x' })).toEqual({})
    expect(stripInheritedAuthHeaders({ 'x-api-key': 'sk-x' })).toEqual({})
    expect(stripInheritedAuthHeaders({ 'X-API-KEY': 'sk-x' })).toEqual({})
  })

  test('preserves other headers unchanged', () => {
    const input = {
      'User-Agent': 'free-code/1.0',
      'X-Claude-Code-Session-Id': 'abc',
      'X-Stainless-Custom': 'value',
    }
    expect(stripInheritedAuthHeaders(input)).toEqual(input)
  })

  test('strips multiple auth variants in one call', () => {
    const input = {
      'User-Agent': 'free-code',
      Authorization: 'Bearer anthropic',
      'x-api-key': 'sk-ant',
      'X-Other': 'keep',
    }
    expect(stripInheritedAuthHeaders(input)).toEqual({
      'User-Agent': 'free-code',
      'X-Other': 'keep',
    })
  })

  test('does not match similar-but-distinct headers', () => {
    // Must not strip Authorization-Foo, x-api-keychain, etc.
    const input = {
      'Authorization-Type': 'Bearer',
      'X-Api-Key-Hint': 'sk',
      authorization2: 'val',
    }
    expect(stripInheritedAuthHeaders(input)).toEqual(input)
  })
})

describe('non-direct provider auth-suppression helpers', () => {
  test('suppresses SDK api key and bearer token defaults when provider owns auth', () => {
    expect(NON_DIRECT_ENV_AUTH_SUPPRESSION).toEqual({
      apiKey: null,
      authToken: null,
    })
  })

  test('suppresses only SDK bearer token when provider supplies api key', () => {
    expect(NON_DIRECT_ENV_BEARER_SUPPRESSION).toEqual({ authToken: null })
  })
})

describe('createFoundrySkipAuthFetch', () => {
  test('strips x-api-key from outgoing request headers', async () => {
    let observedHeaders: Headers | undefined
    const baseFetch = ((input: unknown, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof globalThis.fetch
    const wrapped = createFoundrySkipAuthFetch(baseFetch)
    await wrapped('https://foundry.example/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': 'foundry-skip-auth-placeholder',
        'content-type': 'application/json',
        'x-anthropic-version': '2023-06-01',
      },
      body: '{}',
    })
    expect(observedHeaders?.get('x-api-key')).toBeNull()
    expect(observedHeaders?.get('content-type')).toBe('application/json')
    expect(observedHeaders?.get('x-anthropic-version')).toBe('2023-06-01')
  })

  test('strips case-variants of x-api-key', async () => {
    let observedHeaders: Headers | undefined
    const baseFetch = ((input: unknown, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof globalThis.fetch
    const wrapped = createFoundrySkipAuthFetch(baseFetch)
    await wrapped('https://foundry.example/anthropic/v1/messages', {
      headers: { 'X-Api-Key': 'placeholder', 'X-API-KEY': 'placeholder' },
    })
    // Headers normalize names to lowercase; both variants map to the same slot.
    expect(observedHeaders?.get('x-api-key')).toBeNull()
  })

  test('passes through input and other init unchanged', async () => {
    let observedInput: unknown
    let observedBody: BodyInit | null | undefined
    let observedMethod: string | undefined
    const baseFetch = ((input: unknown, init?: RequestInit) => {
      observedInput = input
      observedBody = init?.body
      observedMethod = init?.method
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof globalThis.fetch
    const wrapped = createFoundrySkipAuthFetch(baseFetch)
    await wrapped('https://foundry.example/anthropic/v1/messages', {
      method: 'POST',
      body: '{"foo":"bar"}',
      headers: { 'x-api-key': 'placeholder' },
    })
    expect(observedInput).toBe('https://foundry.example/anthropic/v1/messages')
    expect(observedBody).toBe('{"foo":"bar"}')
    expect(observedMethod).toBe('POST')
  })

  test('defaults to globalThis.fetch when no base fetch is passed', () => {
    // Just verify the wrapper returns a function; runtime use of
    // globalThis.fetch is covered by the SDK integration.
    const wrapped = createFoundrySkipAuthFetch(undefined)
    expect(typeof wrapped).toBe('function')
  })
})

describe('direct Anthropic unix-socket routing gate', () => {
  test('allows only production HTTPS api.anthropic.com', () => {
    expect(routesToProdAnthropicAPI('https://api.anthropic.com')).toBe(true)
    expect(routesToProdAnthropicAPI('https://api.anthropic.com/v1')).toBe(true)
    expect(routesToProdAnthropicAPI('https://api.anthropic.com:443')).toBe(true)
  })

  test('rejects staging, custom, insecure, credential-bearing, and malformed base URLs', () => {
    expect(routesToProdAnthropicAPI('https://api-staging.anthropic.com')).toBe(false)
    expect(routesToProdAnthropicAPI('https://proxy.example/anthropic')).toBe(false)
    expect(routesToProdAnthropicAPI('http://api.anthropic.com')).toBe(false)
    expect(routesToProdAnthropicAPI('https://api.anthropic.com:8443')).toBe(false)
    expect(routesToProdAnthropicAPI('https://api.anthropic.com@proxy.example')).toBe(false)
    expect(routesToProdAnthropicAPI('https://user:pass@api.anthropic.com')).toBe(false)
    expect(routesToProdAnthropicAPI('')).toBe(false)
    expect(routesToProdAnthropicAPI('not a url')).toBe(false)
  })
})
