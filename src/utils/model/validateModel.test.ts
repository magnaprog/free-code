/**
 * Regression coverage for `validateModel`'s OpenCode Zen detection
 * (Codex finding #2, round-41 fix). Pre-fix, validateModel marked
 * 'openai-responses' as wired only when `OPENAI_API_KEY` was set:
 *
 *   const wiredAdapters = new Set([
 *     ...(process.env.OPENAI_API_KEY ? ['openai-responses'] : []),
 *     'bedrock-converse',
 *   ])
 *
 * But OpenCode Zen is wired via `OPENCODE_API_KEY` (not OPENAI_API_KEY)
 * and supports three runtime transports per model family:
 *   - claude-*  → anthropic_messages   (wired)
 *   - gpt-*     → openai_responses     (wired)
 *   - others    → openai_chat_completions (wired)
 *   - gemini-*  → gemini_native        (intentionally fail-closed)
 *
 * Pre-fix: every OpenCode model was rejected by validateModel when
 * OPENAI_API_KEY was unset, even though the runtime client at
 * `getAnthropicClient()` would have routed them correctly.
 *
 * The post-fix path short-circuits only when OpenCode is the selected
 * provider and has a key, returning valid for the three wired transports
 * and invalid for Gemini or missing OpenCode auth.
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

describe('validateModel — OpenCode Zen routing (round-41 / Codex #2 regression)', () => {
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

  test('OpenCode short-circuit does not fire when OPENCODE_API_KEY is absent', async () => {
    // Without OPENCODE_API_KEY, the short-circuit returns to the
    // generic adapter check; without OPENAI_API_KEY that check now
    // rejects (pre-fix behavior — which is the desired behavior here
    // because OpenCode isn't actually usable).
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    // No OPENCODE_API_KEY.

    const result = await validateModel('qwen2.5-coder-32b-instruct')
    expect(result.valid).toBe(false)
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
