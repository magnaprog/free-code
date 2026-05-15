/**
 * Verify the auth-header strip utility removes case-variants of
 * Authorization and X-Api-Key from inherited headers. Used by the
 * OpenCode anthropic_messages branch in client.ts so a stray Anthropic
 * credential from ANTHROPIC_CUSTOM_HEADERS, configureApiKeyHeaders, or
 * the api-key helper does not leak to the OpenCode gateway via the SDK
 * header right-merge.
 *
 * Round 9: imports the production helper instead of a black-box reimpl,
 * so test drift against the real implementation cannot occur.
 */
import { describe, expect, test } from 'bun:test'
import { stripInheritedAuthHeaders } from './client.js'

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
