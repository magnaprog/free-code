import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { isEnvTruthy } from '../envUtils.js'

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

export function getAPIProvider(): APIProvider {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
            isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENCODE_GO)
          ? 'openai'
          : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

const ANTHROPIC_API_HOST = 'api.anthropic.com'
const ANTHROPIC_API_HOSTS = [ANTHROPIC_API_HOST] as const
const ANTHROPIC_API_HOSTS_WITH_STAGING = [
  ANTHROPIC_API_HOST,
  'api-staging.anthropic.com',
] as const

export function isHttpsAnthropicApiBaseUrl(
  baseUrl: string,
  { allowStaging = false }: { allowStaging?: boolean } = {},
): boolean {
  try {
    const url = new URL(baseUrl)
    const allowedHosts = allowStaging
      ? ANTHROPIC_API_HOSTS_WITH_STAGING
      : ANTHROPIC_API_HOSTS
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      allowedHosts.includes(url.hostname)
    )
  } catch {
    return false
  }
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!baseUrl) return true

  return isHttpsAnthropicApiBaseUrl(baseUrl, {
    allowStaging: process.env.USER_TYPE === 'ant',
  })
}
