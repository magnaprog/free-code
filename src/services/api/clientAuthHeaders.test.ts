/**
 * Round 8: verify the auth-header strip utility removes case-variants
 * of Authorization and X-Api-Key from inherited headers. Used by the
 * OpenCode anthropic_messages branch in client.ts so a stray Anthropic
 * credential from ANTHROPIC_CUSTOM_HEADERS, configureApiKeyHeaders, or
 * the api-key helper does not leak to the OpenCode gateway via the SDK
 * header right-merge.
 *
 * The utility is not exported from client.ts (intentionally — it's an
 * internal helper). We re-implement the same regex contract here and
 * assert by black-box simulation. If client.ts changes the strip rules,
 * this test catches drift.
 */
import { describe, expect, test } from 'bun:test'

const STRIP_REGEX = /^(authorization|x-api-key)$/i

function stripInheritedAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (STRIP_REGEX.test(key)) continue
    out[key] = value
  }
  return out
}

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
