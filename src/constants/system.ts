// Critical system constants extracted to break circular dependencies

import { logForDebugging } from '../utils/debug.js'
import { getAPIProvider } from '../utils/model/providers.js'
import { getWorkload } from '../utils/workloadContext.js'

const DEFAULT_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude.`
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX = `You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.`
const AGENT_SDK_PREFIX = `You are a Claude agent, built on Anthropic's Claude Agent SDK.`

const CLI_SYSPROMPT_PREFIX_VALUES = [
  DEFAULT_PREFIX,
  AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX,
  AGENT_SDK_PREFIX,
] as const

export type CLISyspromptPrefix = (typeof CLI_SYSPROMPT_PREFIX_VALUES)[number]

/**
 * All possible CLI sysprompt prefix values, used by splitSysPromptPrefix
 * to identify prefix blocks by content rather than position.
 */
export const CLI_SYSPROMPT_PREFIXES: ReadonlySet<string> = new Set(
  CLI_SYSPROMPT_PREFIX_VALUES,
)

export function getCLISyspromptPrefix(options?: {
  isNonInteractive: boolean
  hasAppendSystemPrompt: boolean
}): CLISyspromptPrefix {
  const apiProvider = getAPIProvider()
  if (apiProvider === 'vertex') {
    return DEFAULT_PREFIX
  }

  if (options?.isNonInteractive) {
    if (options.hasAppendSystemPrompt) {
      return AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX
    }
    return AGENT_SDK_PREFIX
  }
  return DEFAULT_PREFIX
}

/**
 * Check if upstream Claude Code attribution is enabled.
 *
 * free-code disables Anthropic attribution, prompt-derived fingerprints, and
 * CCH attestation by default to preserve the no-telemetry/no-fingerprinting
 * project contract. Set this only for explicit upstream compatibility testing.
 */
export function isAttributionHeaderEnabled(): boolean {
  return process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION === 'true'
}

/**
 * Get attribution header for API requests.
 * Returns a header string with cc_version (including fingerprint) and cc_entrypoint.
 * Disabled by default in free-code; opt in with FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION=true.
 *
 * Includes a `cch=00000` placeholder that is replaced with a computed
 * xxHash64-based integrity hash before the request is sent when attribution is enabled.
 */
export function getAttributionHeader(fingerprint: string): string {
  if (!isAttributionHeaderEnabled()) {
    return ''
  }

  const version = `${MACRO.VERSION}.${fingerprint}`
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown'

  const cch = ' cch=00000;'
  // cc_workload: turn-scoped hint so the API can route e.g. cron-initiated
  // requests to a lower QoS pool. Absent = interactive default. Safe re:
  // fingerprint (computed from msg chars + version only, line 78 above) and
  // cch attestation (placeholder overwritten in serialized body bytes after
  // this string is built). Server _parse_cc_header tolerates unknown extra
  // fields so old API deploys silently ignore this.
  const workload = getWorkload()
  const workloadPair = workload ? ` cc_workload=${workload};` : ''
  const header = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=${entrypoint};${cch}${workloadPair}`

  logForDebugging(`attribution header ${header}`)
  return header
}
