import { describe, expect, test } from 'bun:test'
import { redactSecrets, redactSecretValues } from './redaction.js'

describe('secret redaction', () => {
  test('redacts snake_case and camelCase token fields recursively', () => {
    expect(
      redactSecretValues({
        access_token: 'access-secret',
        refreshToken: 'refresh-secret',
        nested: {
          clientSecret: 'client-secret',
          safe: 'visible',
        },
      }),
    ).toEqual({
      access_token: '[REDACTED]',
      refreshToken: '[REDACTED]',
      nested: {
        clientSecret: '[REDACTED]',
        safe: 'visible',
      },
    })
  })

  test('does not redact token-count fields or non-plain objects', () => {
    const date = new Date('2026-01-01T00:00:00Z')
    expect(redactSecretValues({ max_tokens: 100, tokenCount: 2, date })).toEqual({
      max_tokens: 100,
      tokenCount: 2,
      date,
    })
  })

  test('redacts token-like JSON strings and bearer tokens', () => {
    const redacted = redactSecrets(
      '{"access_token":"abc123","clientSecret":"def456","safe":"visible"} Authorization: Bearer sk-secret-token',
    )

    expect(redacted).not.toContain('abc123')
    expect(redacted).not.toContain('def456')
    expect(redacted).not.toContain('sk-secret-token')
    expect(redacted).toContain('"safe":"visible"')
  })

  test('redacts sensitive URL parameters', () => {
    const redacted = redactSecrets(
      'https://example.test/callback?code=abc&state=def&foo=bar access_token=secret',
    )

    expect(redacted).toContain('code=[REDACTED]')
    expect(redacted).toContain('state=[REDACTED]')
    expect(redacted).toContain('access_token=[REDACTED]')
    expect(redacted).toContain('foo=bar')
  })
})
