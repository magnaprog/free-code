import { getSdkBetas } from '../../bootstrap/state.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { getGlobalConfig } from '../../utils/config.js'
import { getContextWindowForModel } from '../../utils/context.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export type CompactionConfig = {
  enabled: boolean
  auto: {
    enabled: boolean
    thresholdPct: number
    hardBlockPct: number
    reserveOutputTokens: number
    maxConsecutiveFailures: number
    maxImmediateRefills: number
  }
  toolResultBudget: {
    enabled: boolean
    perMessageChars: number
    previewBytes: number
  }
  timeBasedMicrocompact: {
    enabled: boolean
    gapThresholdMinutes: number
    keepRecent: number
  }
  cachedMicrocompact: {
    enabled: boolean | 'provider-capability'
    triggerToolResults: number
    keepRecent: number
  }
  sessionMemory: {
    enabled: boolean
    initAfterTokens: number
    updateAfterTokens: number
    updateAfterToolCalls: number
    waitForExtractionBeforeCompactMs: number
  }
  summary: {
    structured: boolean
    verifier: boolean
    targetTokens: number
    emergencyTokens: number
  }
  tail: {
    minTokens: number
    targetTokens: number
    maxTokens: number
    minTextMessages: number
  }
}

export const DEFAULT_COMPACTION_CONFIG = {
  enabled: true,
  auto: {
    enabled: true,
    thresholdPct: 0.78,
    hardBlockPct: 0.95,
    reserveOutputTokens: 20_000,
    maxConsecutiveFailures: 3,
    maxImmediateRefills: 3,
  },
  toolResultBudget: {
    enabled: true,
    perMessageChars: 120_000,
    previewBytes: 2_000,
  },
  timeBasedMicrocompact: {
    enabled: true,
    gapThresholdMinutes: 60,
    keepRecent: 5,
  },
  cachedMicrocompact: {
    enabled: 'provider-capability',
    triggerToolResults: 12,
    keepRecent: 3,
  },
  sessionMemory: {
    enabled: true,
    initAfterTokens: 20_000,
    updateAfterTokens: 8_000,
    updateAfterToolCalls: 4,
    waitForExtractionBeforeCompactMs: 8_000,
  },
  summary: {
    structured: false,
    verifier: false,
    targetTokens: 8_000,
    emergencyTokens: 4_000,
  },
  tail: {
    minTokens: 12_000,
    targetTokens: 25_000,
    maxTokens: 40_000,
    minTextMessages: 6,
  },
} satisfies CompactionConfig

export type CompactionThresholds = {
  warn: number
  compact: number
  block: number
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function parsePercentOverride(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100
    ? parsed / 100
    : undefined
}

function getEffectiveCompactionWindow(model: string): number {
  const autoCompactWindow = parsePositiveInt(
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  )
  const contextWindow = Math.min(
    getContextWindowForModel(model, getSdkBetas()),
    autoCompactWindow ?? Number.MAX_SAFE_INTEGER,
  )
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return contextWindow - reservedTokensForSummary
}

function isAutoCompactionEnabledFromCurrentConfig(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) return false
  return getGlobalConfig().autoCompactEnabled
}

function getAutoCompactThresholdForConfig(model: string): number {
  const effectiveWindow = getEffectiveCompactionWindow(model)
  const autocompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS
  const envPercent = parsePercentOverride(
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  )
  if (envPercent !== undefined) {
    return Math.min(Math.floor(effectiveWindow * envPercent), autocompactThreshold)
  }
  return autocompactThreshold
}

export function getCompactionThresholds(model: string): CompactionThresholds {
  const effectiveWindow = getEffectiveCompactionWindow(model)
  const compact = isAutoCompactionEnabledFromCurrentConfig()
    ? getAutoCompactThresholdForConfig(model)
    : effectiveWindow
  const block =
    parsePositiveInt(process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE) ??
    effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS

  return {
    warn: Math.max(0, compact - WARNING_THRESHOLD_BUFFER_TOKENS),
    compact,
    block,
  }
}

export function getCompactionConfig(model?: string): CompactionConfig {
  const enabled = !isEnvTruthy(process.env.DISABLE_COMPACT)
  const autoEnabled = enabled && isAutoCompactionEnabledFromCurrentConfig()
  const effectiveWindow = model ? getEffectiveCompactionWindow(model) : undefined
  const compactThreshold = model ? getAutoCompactThresholdForConfig(model) : undefined
  const blockThreshold = model ? getCompactionThresholds(model).block : undefined

  return {
    ...DEFAULT_COMPACTION_CONFIG,
    enabled,
    auto: {
      ...DEFAULT_COMPACTION_CONFIG.auto,
      enabled: autoEnabled,
      thresholdPct:
        parsePercentOverride(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE) ??
        (effectiveWindow && compactThreshold
          ? compactThreshold / effectiveWindow
          : DEFAULT_COMPACTION_CONFIG.auto.thresholdPct),
      hardBlockPct:
        effectiveWindow && blockThreshold
          ? blockThreshold / effectiveWindow
          : DEFAULT_COMPACTION_CONFIG.auto.hardBlockPct,
      reserveOutputTokens: AUTOCOMPACT_BUFFER_TOKENS,
    },
    summary: {
      ...DEFAULT_COMPACTION_CONFIG.summary,
      structured: isEnvTruthy(process.env.CLAUDE_CODE_STRUCTURED_COMPACT),
      verifier: isEnvTruthy(process.env.CLAUDE_CODE_COMPACT_SUMMARY_VERIFIER),
    },
  }
}

export function formatCompactionConfigSummary(config: CompactionConfig): string {
  return [
    config.enabled ? 'compact:on' : 'compact:off',
    config.auto.enabled
      ? `auto:${Math.round(config.auto.thresholdPct * 100)}%`
      : 'auto:off',
    `block:${Math.round(config.auto.hardBlockPct * 100)}%`,
    `tail:${config.tail.targetTokens}`,
    config.summary.structured ? 'structured-summary:on' : 'structured-summary:off',
  ].join(' · ')
}
