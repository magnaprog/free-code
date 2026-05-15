import { isEnvTruthy } from '../../utils/envUtils.js'

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go'
export const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

export type OpenCodeGoEnv = Record<string, string | undefined>

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
    OPENCODE_GO_DEFAULT_BASE_URL
  )
}

export function getOpenCodeGoModel(
  env: OpenCodeGoEnv = process.env,
): string | undefined {
  return (
    env.OPENCODE_MODEL ||
    env.OPENCODE_GO_MODEL ||
    env.FREE_CODE_OPENCODE_GO_MODEL ||
    env.OPENAI_MODEL
  )
}

export function normalizeOpenCodeGoModel(model: string): string {
  return model.replace(/^opencode-go\//, '')
}
