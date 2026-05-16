import { describe, expect, test } from 'bun:test'
import {
  getOpenCodeAnthropicBaseUrl,
  getOpenCodeGoApiKey,
  getOpenCodeGoBaseUrl,
  getOpenCodeGoModel,
  getOpenCodeTransportForModel,
  isOpenCodeGoEnabled,
  normalizeOpenCodeGoModel,
  OPENCODE_ZEN_DEFAULT_BASE_URL,
} from './openCodeGo.js'

describe('OpenCode Zen helpers', () => {
  test('canonical default base URL matches current OpenCode docs', () => {
    // B14: previous default `/zen/go/v1` was stale; current OpenCode docs
    // (https://opencode.ai/docs/zen, verified 2026-05-14) show /zen/v1.
    expect(OPENCODE_ZEN_DEFAULT_BASE_URL).toBe('https://opencode.ai/zen/v1')
    expect(getOpenCodeGoBaseUrl({})).toBe('https://opencode.ai/zen/v1')
  })

  test('env overrides applied in priority order', () => {
    expect(
      getOpenCodeGoBaseUrl({
        OPENCODE_BASE_URL: 'https://example.com/zen/v1',
      }),
    ).toBe('https://example.com/zen/v1')
    expect(
      getOpenCodeGoBaseUrl({
        FREE_CODE_OPENCODE_GO_BASE_URL: 'https://fallback.example/zen/v1',
      }),
    ).toBe('https://fallback.example/zen/v1')
    // OPENCODE_BASE_URL wins over FREE_CODE_OPENCODE_GO_BASE_URL.
    expect(
      getOpenCodeGoBaseUrl({
        OPENCODE_BASE_URL: 'https://primary.example/zen/v1',
        FREE_CODE_OPENCODE_GO_BASE_URL: 'https://fallback.example/zen/v1',
      }),
    ).toBe('https://primary.example/zen/v1')
  })

  test('anthropic base URL strips trailing /v1', () => {
    // Anthropic SDK appends /v1/messages itself; avoid double-pathing.
    expect(getOpenCodeAnthropicBaseUrl({})).toBe('https://opencode.ai/zen')
    expect(
      getOpenCodeAnthropicBaseUrl({
        OPENCODE_BASE_URL: 'https://custom.example/zen/v1',
      }),
    ).toBe('https://custom.example/zen')
    // Already-stripped URL is passed through.
    expect(
      getOpenCodeAnthropicBaseUrl({
        OPENCODE_BASE_URL: 'https://custom.example/zen',
      }),
    ).toBe('https://custom.example/zen')
  })

  test('model name prefixes strip both legacy and current namespaces', () => {
    expect(normalizeOpenCodeGoModel('opencode-go/qwen-test')).toBe('qwen-test')
    expect(normalizeOpenCodeGoModel('opencode/kimi-k2.6')).toBe('kimi-k2.6')
    // No prefix passes through.
    expect(normalizeOpenCodeGoModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
  })

  test('configured model is normalized before runtime use', () => {
    expect(getOpenCodeGoModel({ OPENCODE_MODEL: 'opencode/gpt-5.4-mini' })).toBe(
      'gpt-5.4-mini',
    )
    expect(
      getOpenCodeGoModel({ OPENCODE_GO_MODEL: 'opencode-go/claude-sonnet-4-6' }),
    ).toBe('claude-sonnet-4-6')
  })

  test('per-model transport routing — claude → anthropic_messages', () => {
    expect(getOpenCodeTransportForModel('claude-opus-4-7')).toBe(
      'anthropic_messages',
    )
    expect(getOpenCodeTransportForModel('claude-sonnet-4-6')).toBe(
      'anthropic_messages',
    )
    expect(getOpenCodeTransportForModel('opencode/claude-haiku-4-5')).toBe(
      'anthropic_messages',
    )
  })

  test('per-model transport routing — gpt → openai_responses', () => {
    expect(getOpenCodeTransportForModel('gpt-5.5')).toBe('openai_responses')
    expect(getOpenCodeTransportForModel('gpt-5.5-pro')).toBe('openai_responses')
    expect(getOpenCodeTransportForModel('opencode/gpt-5.4-mini')).toBe(
      'openai_responses',
    )
  })

  test('per-model transport routing — gemini → gemini_native (not wired)', () => {
    expect(getOpenCodeTransportForModel('gemini-3.1-pro')).toBe('gemini_native')
    expect(getOpenCodeTransportForModel('opencode/gemini-3-flash')).toBe(
      'gemini_native',
    )
  })

  test('isOpenCodeGoEnabled gates on CLAUDE_CODE_USE_OPENCODE_GO truthy value', () => {
    expect(isOpenCodeGoEnabled({})).toBe(false)
    expect(isOpenCodeGoEnabled({ CLAUDE_CODE_USE_OPENCODE_GO: '1' })).toBe(true)
    expect(isOpenCodeGoEnabled({ CLAUDE_CODE_USE_OPENCODE_GO: 'true' })).toBe(
      true,
    )
    // Falsy values from isEnvTruthy: empty, 'false', '0', undefined.
    expect(isOpenCodeGoEnabled({ CLAUDE_CODE_USE_OPENCODE_GO: '' })).toBe(false)
    expect(isOpenCodeGoEnabled({ CLAUDE_CODE_USE_OPENCODE_GO: '0' })).toBe(false)
    expect(isOpenCodeGoEnabled({ CLAUDE_CODE_USE_OPENCODE_GO: 'false' })).toBe(
      false,
    )
  })

  test('getOpenCodeGoApiKey follows documented env precedence', () => {
    // OPENCODE_API_KEY wins (user-facing canonical name).
    expect(getOpenCodeGoApiKey({ OPENCODE_API_KEY: 'a' })).toBe('a')
    // Then legacy OPENCODE_GO_API_KEY.
    expect(getOpenCodeGoApiKey({ OPENCODE_GO_API_KEY: 'b' })).toBe('b')
    // Then fork-specific FREE_CODE_OPENCODE_GO_API_KEY.
    expect(getOpenCodeGoApiKey({ FREE_CODE_OPENCODE_GO_API_KEY: 'c' })).toBe(
      'c',
    )
    // Precedence: OPENCODE_API_KEY > OPENCODE_GO_API_KEY > FREE_CODE_*.
    expect(
      getOpenCodeGoApiKey({
        OPENCODE_API_KEY: 'a',
        OPENCODE_GO_API_KEY: 'b',
        FREE_CODE_OPENCODE_GO_API_KEY: 'c',
      }),
    ).toBe('a')
    expect(
      getOpenCodeGoApiKey({
        OPENCODE_GO_API_KEY: 'b',
        FREE_CODE_OPENCODE_GO_API_KEY: 'c',
      }),
    ).toBe('b')
    // Empty env returns undefined (no key set → caller must throw).
    expect(getOpenCodeGoApiKey({})).toBeUndefined()
    // Empty string treated as unset (|| falls through).
    expect(
      getOpenCodeGoApiKey({
        OPENCODE_API_KEY: '',
        OPENCODE_GO_API_KEY: 'b',
      }),
    ).toBe('b')
  })

  test('per-model transport routing — others → openai_chat_completions', () => {
    expect(getOpenCodeTransportForModel('qwen3.6-plus')).toBe(
      'openai_chat_completions',
    )
    expect(getOpenCodeTransportForModel('kimi-k2.6')).toBe(
      'openai_chat_completions',
    )
    expect(getOpenCodeTransportForModel('glm-5.1')).toBe(
      'openai_chat_completions',
    )
    expect(getOpenCodeTransportForModel('minimax-m2.7')).toBe(
      'openai_chat_completions',
    )
    expect(getOpenCodeTransportForModel('deepseek-v4-flash-free')).toBe(
      'openai_chat_completions',
    )
    expect(getOpenCodeTransportForModel('opencode/big-pickle')).toBe(
      'openai_chat_completions',
    )
  })
})
