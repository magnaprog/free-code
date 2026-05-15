import { isEnvTruthy } from '../../utils/envUtils.js'

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go'
// Verified against OpenCode Zen docs 2026-05-14. The historical `/zen/go/v1`
// path is treated as legacy; if a user has set it via env override we
// honor that, otherwise the canonical base URL applies.
export const OPENCODE_ZEN_DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1'
// Back-compat alias for code/tests that reference the legacy export name.
export const OPENCODE_GO_DEFAULT_BASE_URL = OPENCODE_ZEN_DEFAULT_BASE_URL

export type OpenCodeGoEnv = Record<string, string | undefined>

/**
 * Per-model transport routing. OpenCode Zen routes models to FOUR
 * different endpoints depending on the model family. Verified against
 * https://opencode.ai/docs/zen on 2026-05-14:
 *   - claude-*  → /messages              (Anthropic Messages)
 *   - gpt-*     → /responses             (OpenAI Responses)
 *   - gemini-*  → /models/{id}  (Gemini native — not wired yet)
 *   - else      → /chat/completions      (OpenAI Chat Completions; qwen,
 *                                          kimi, glm, minimax, deepseek)
 */
export type OpenCodeTransport =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'gemini_native'

export function getOpenCodeTransportForModel(model: string): OpenCodeTransport {
  const normalized = normalizeOpenCodeGoModel(model)
  if (normalized.startsWith('claude-')) return 'anthropic_messages'
  if (normalized.startsWith('gpt-')) return 'openai_responses'
  if (normalized.startsWith('gemini-')) return 'gemini_native'
  return 'openai_chat_completions'
}

export function isOpenCodeGoEnabled(
  env: OpenCodeGoEnv = process.env,
): boolean {
  return isEnvTruthy(env.CLAUDE_CODE_USE_OPENCODE_GO)
}

export function getOpenCodeGoApiKey(
  env: OpenCodeGoEnv = process.env,
): string | undefined {
  return (
    env.OPENCODE_API_KEY ||
    env.OPENCODE_GO_API_KEY ||
    env.FREE_CODE_OPENCODE_GO_API_KEY
  )
}

export function getOpenCodeGoBaseUrl(
  env: OpenCodeGoEnv = process.env,
): string {
  return (
    env.OPENCODE_BASE_URL ||
    env.FREE_CODE_OPENCODE_GO_BASE_URL ||
    OPENCODE_ZEN_DEFAULT_BASE_URL
  )
}

/**
 * Derive the Anthropic-SDK-compatible base URL from the configured
 * OpenCode base URL. The SDK appends `/v1/messages` itself, so we strip
 * the trailing `/v1` from the canonical OpenCode URL to avoid double-
 * pathing. If the user has overridden to a URL that does NOT end in
 * `/v1` we pass it through unchanged.
 */
export function getOpenCodeAnthropicBaseUrl(
  env: OpenCodeGoEnv = process.env,
): string {
  const base = getOpenCodeGoBaseUrl(env)
  return base.replace(/\/v1\/?$/, '')
}

export function getOpenCodeGoModel(
  env: OpenCodeGoEnv = process.env,
): string | undefined {
  const model =
    env.OPENCODE_MODEL ||
    env.OPENCODE_GO_MODEL ||
    env.FREE_CODE_OPENCODE_GO_MODEL ||
    env.OPENAI_MODEL
  return model ? normalizeOpenCodeGoModel(model) : undefined
}

export function normalizeOpenCodeGoModel(model: string): string {
  // Strip both `opencode-go/` (legacy) and `opencode/` (current per docs)
  // prefixes. Internal model id never carries the namespace.
  return model.replace(/^opencode(-go)?\//, '')
}
