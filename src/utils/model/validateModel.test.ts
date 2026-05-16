/**
 * OpenCode Zen is wired via OpenCode-specific API keys and supports
 * model-family-specific transports:
 *   - claude-*  → anthropic_messages
 *   - gpt-*     → openai_responses
 *   - others    → openai_chat_completions
 *   - gemini-*  → gemini_native (not wired here)
 *
 * Validation must follow the same provider precedence and transport rules
 * as getAnthropicClient().
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { validateModel } from './validateModel.js'

const TRACKED = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_OPENCODE_GO',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_GO_API_KEY',
  'FREE_CODE_OPENCODE_GO_API_KEY',
] as const

const originalEnv = Object.fromEntries(
  TRACKED.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of TRACKED) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('validateModel — OpenCode Zen routing', () => {
  test('accepts OpenCode chat-completions model without OPENAI_API_KEY', async () => {
    // qwen* is a chat-completions transport per
    // `getOpenCodeTransportForModel`. With OpenCode enabled +
    // OPENCODE_API_KEY, the OpenCode short-circuit fires before
    // reaching the OPENAI_API_KEY-gated wiredAdapters check.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'
    // Explicitly NO OPENAI_API_KEY — this is the bug scenario.

    const result = await validateModel('qwen2.5-coder-32b-instruct')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('accepts OpenCode Claude model (anthropic_messages transport)', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'

    const result = await validateModel('claude-sonnet-4-5-20250929')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('accepts OpenCode GPT model (openai_responses transport)', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'

    const result = await validateModel('gpt-5-codex')
    expect(result.valid).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('rejects OpenCode Gemini model — native /models/{id} not wired', async () => {
    // Gemini is intentional fail-closed; the runtime client also throws.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'

    const result = await validateModel('gemini-2-flash')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Gemini')
    expect(result.error).toContain('not wired')
  })

  test('rejects OpenCode models when OPENCODE_API_KEY is absent', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'

    const result = await validateModel('qwen2.5-coder-32b-instruct')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('OpenCode Zen requires OPENCODE_API_KEY')
  })

  test('rejects aliases when OpenCode is enabled without a key', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'

    const result = await validateModel('sonnet')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('OpenCode Zen requires OPENCODE_API_KEY')
  })

  test('rejects aliases when OpenAI provider has no usable credential', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    const result = await validateModel('sonnet')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('no OpenAI-family credential')
  })

  test('rejects Codex-only models when OpenAI API key takes precedence', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-openai-test'

    const result = await validateModel('gpt-5.3-codex-spark')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('not OpenAI Responses')
  })

  test('Vertex and Foundry validation uses the selected runtime provider', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'

    const result = await validateModel('gemini-2-flash')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('vertex-gemini')
  })

  test('OpenCode validation is not reused when a higher-precedence provider wins', async () => {
    const model = 'qwen2.5-coder-32b-instruct'

    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'
    expect((await validateModel(model)).valid).toBe(true)

    delete process.env.CLAUDE_CODE_USE_OPENAI
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'

    const result = await validateModel(model)
    expect(result.valid).toBe(false)
    expect(result.error).toContain('azure-foundry-inference')
  })

  test('OpenCode short-circuit does not fire when CLAUDE_CODE_USE_OPENCODE_GO is unset', async () => {
    // OPENCODE_API_KEY alone (without USE_OPENCODE_GO) does not trigger
    // the OpenCode short-circuit. Falls through to generic adapter
    // check. Without OPENAI_API_KEY, rejected.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'

    const result = await validateModel('qwen2.5-coder-32b-instruct')
    expect(result.valid).toBe(false)
  })
})
