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
const ANTHROPIC_STAGING_API_HOST = 'api-staging.anthropic.com'

/**
 * Strict URL gate: returns true only when `baseUrl` is a plain direct
 * Anthropic API URL. Used by the first-party-only behavior gate
 * (`isFirstPartyAnthropicBaseUrl`) and the production-only unix-socket
 * routing gate (`routesToProdAnthropicAPI`).
 *
 * Requires:
 *   - protocol === 'https:'
 *   - default port (WHATWG normalizes `:443` to empty)
 *   - no embedded userinfo (e.g. `user:pass@`)
 *   - hostname exact-match against the prod allowlist (or staging
 *     allowlist when `allowStaging` is true)
 *
 * Does NOT trim the input — that's caller responsibility. WHATWG URL
 * tolerates surrounding whitespace, but `isFirstPartyAnthropicBaseUrl`
 * needs trim to distinguish "blank → default prod" from
 * "explicit URL", so the trim lives there.
 */
export function isHttpsAnthropicApiBaseUrl(
  baseUrl: string,
  { allowStaging = false }: { allowStaging?: boolean } = {},
): boolean {
  try {
    const url = new URL(baseUrl)
    const isAllowedHost =
      url.hostname === ANTHROPIC_API_HOST ||
      (allowStaging && url.hostname === ANTHROPIC_STAGING_API_HOST)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      isAllowedHost
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
