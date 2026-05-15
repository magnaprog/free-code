import { describe, expect, test } from 'bun:test'
import {
  classifyAnthropicMessagesUrl,
  countTokensUnsupportedResponse,
} from './anthropicMessagesPath.js'

describe('classifyAnthropicMessagesUrl', () => {
  test('classifies plain /v1/messages as create', () => {
    expect(classifyAnthropicMessagesUrl('https://api.anthropic.com/v1/messages')).toBe(
      'create',
    )
    expect(
      classifyAnthropicMessagesUrl('https://api.anthropic.com/v1/messages?foo=1'),
    ).toBe('create')
  })

  // Path-prefixed base URL — ANTHROPIC_BASE_URL=https://proxy/anthropic.
  test('classifies path-prefixed /anthropic/v1/messages as create', () => {
    expect(
      classifyAnthropicMessagesUrl('https://proxy.example/anthropic/v1/messages'),
    ).toBe('create')
    expect(
      classifyAnthropicMessagesUrl(
        'https://proxy.example/anthropic/v1/messages?beta=foo',
      ),
    ).toBe('create')
  })

  // /v1/messages/count_tokens must NEVER classify as create. Forwarding it
  // to provider-native generation would leak prompt/tool bodies to
  // api.anthropic.com and trigger paid upstream completions.
  test('classifies /v1/messages/count_tokens as count_tokens', () => {
    expect(
      classifyAnthropicMessagesUrl(
        'https://api.anthropic.com/v1/messages/count_tokens',
      ),
    ).toBe('count_tokens')
    expect(
      classifyAnthropicMessagesUrl(
        'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
      ),
    ).toBe('count_tokens')
    expect(
      classifyAnthropicMessagesUrl(
        'https://proxy.example/anthropic/v1/messages/count_tokens?beta=true',
      ),
    ).toBe('count_tokens')
  })

  test('classifies unrelated URLs as other', () => {
    expect(
      classifyAnthropicMessagesUrl('https://api.anthropic.com/v1/models'),
    ).toBe('other')
    expect(
      classifyAnthropicMessagesUrl('https://api.openai.com/v1/chat/completions'),
    ).toBe('other')
    // Suffix that isn't exactly /v1/messages must not match create.
    expect(
      classifyAnthropicMessagesUrl('https://x.example/v1/messages2'),
    ).toBe('other')
  })

  test('relative or malformed URLs use raw-string fallback', () => {
    expect(classifyAnthropicMessagesUrl('/v1/messages')).toBe('create')
    expect(classifyAnthropicMessagesUrl('/v1/messages?b=1')).toBe('create')
    expect(classifyAnthropicMessagesUrl('/v1/messages/count_tokens?b=1')).toBe(
      'count_tokens',
    )
    expect(classifyAnthropicMessagesUrl('not a url')).toBe('other')
  })
})

describe('countTokensUnsupportedResponse', () => {
  test('returns 404 with Anthropic-shaped error body', async () => {
    const response = countTokensUnsupportedResponse()
    expect(response.status).toBe(404)
    const body = (await response.json()) as {
      type?: string
      error?: { type?: string; message?: string }
    }
    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('not_found_error')
    expect(body.error?.message).toContain('count_tokens')
  })
})
