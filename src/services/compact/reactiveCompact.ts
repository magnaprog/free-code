import type { QuerySource } from '../../constants/querySource.js'
import { getUserContext } from '../../context.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { SystemPrompt } from '../../utils/systemPrompt.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
} from '../api/errors.js'
import { logEvent } from '../analytics/index.js'
import { getCompactionConfig } from '../context/compactionConfig.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import {
  compactConversation as defaultCompactConversation,
  stripImagesFromMessages as defaultStripImagesFromMessages,
  type CompactionResult,
} from './compact.js'
import { suppressCompactWarning } from './compactWarningState.js'
import { groupMessagesByApiRound } from './grouping.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import { selectTailForCompaction } from './tailSelector.js'
import { applyToolResultBudget } from '../../utils/toolResultStorage.js'

// PR H: aggressive per-message tool-result limit for emergency recovery.
// Half of the default (which is MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 120K).
// Forces additional offload of large tool results into persisted files
// before the summarizer sees them — reduces prompt_too_long likelihood.
const REACTIVE_AGGRESSIVE_OFFLOAD_LIMIT = 60_000

export type ReactiveCompactFailureReason =
  | 'too_few_groups'
  | 'aborted'
  | 'exhausted'
  | 'error'
  | 'media_unstrippable'

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult }
  | { ok: false; reason: ReactiveCompactFailureReason }

export type ReactiveCompactCacheSafeParams = {
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}

type PreparedReactiveMessages = {
  messages: Message[]
  strippedOlderMedia: boolean
}

export type ReactiveCompactDeps = {
  compactConversation: typeof defaultCompactConversation
  stripImagesFromMessages: typeof defaultStripImagesFromMessages
  setLastSummarizedMessageId: typeof setLastSummarizedMessageId
  runPostCompactCleanup: typeof runPostCompactCleanup
  suppressCompactWarning: typeof suppressCompactWarning
  clearUserContextCache: () => void
}

const DEFAULT_REACTIVE_COMPACT_DEPS: ReactiveCompactDeps = {
  compactConversation: defaultCompactConversation,
  stripImagesFromMessages: defaultStripImagesFromMessages,
  setLastSummarizedMessageId,
  runPostCompactCleanup,
  suppressCompactWarning,
  clearUserContextCache: () => getUserContext.cache.clear?.(),
}

export function isReactiveCompactEnabled(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_REACTIVE_COMPACT) ||
    isEnvTruthy(process.env.CLAUDE_CODE_REACTIVE_ONLY_COMPACT)
  )
}

export function isReactiveOnlyMode(): boolean {
  return isReactiveCompactEnabled() &&
    isEnvTruthy(process.env.CLAUDE_CODE_REACTIVE_ONLY_COMPACT)
}

export function isWithheldPromptTooLong(message: unknown): boolean {
  return (
    isAssistantMessageLike(message) && isPromptTooLongMessage(message)
  )
}

export function isWithheldMediaSizeError(message: unknown): boolean {
  return isAssistantMessageLike(message) && isMediaSizeErrorMessage(message)
}

export async function tryReactiveCompact(
  params: {
    hasAttempted: boolean
    querySource: QuerySource
    aborted: boolean
    messages: Message[]
    cacheSafeParams: ReactiveCompactCacheSafeParams
  },
  deps: ReactiveCompactDeps = DEFAULT_REACTIVE_COMPACT_DEPS,
): Promise<CompactionResult | null> {
  if (!isReactiveCompactEnabled()) return null
  if (params.hasAttempted) return null
  if (params.aborted) return null
  if (params.querySource === 'compact' || params.querySource === 'session_memory') {
    return null
  }

  const outcome = await reactiveCompactOnPromptTooLong(
    params.messages,
    params.cacheSafeParams,
    { trigger: 'auto' },
    deps,
  )
  if (outcome.ok) return outcome.result

  logEvent('tengu_reactive_compact_failed', {
    reasonTooFewGroups: outcome.reason === 'too_few_groups',
    reasonAborted: outcome.reason === 'aborted',
    reasonExhausted: outcome.reason === 'exhausted',
    reasonMediaUnstrippable: outcome.reason === 'media_unstrippable',
    querySourceCompact: params.querySource === 'compact',
    querySourceSessionMemory: params.querySource === 'session_memory',
  })
  return null
}

export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: ReactiveCompactCacheSafeParams,
  options: { customInstructions?: string; trigger: 'manual' | 'auto' },
  deps: ReactiveCompactDeps = DEFAULT_REACTIVE_COMPACT_DEPS,
): Promise<ReactiveCompactOutcome> {
  const { toolUseContext } = cacheSafeParams
  if (toolUseContext.abortController.signal.aborted) {
    return { ok: false, reason: 'aborted' }
  }
  if (groupMessagesByApiRound(messages).length < 2) {
    return { ok: false, reason: 'too_few_groups' }
  }

  const prepared = prepareReactiveMessages(
    messages,
    toolUseContext,
    deps.stripImagesFromMessages,
  )
  if (prepared.messages.length === 0) {
    return { ok: false, reason: 'too_few_groups' }
  }

  // PR H: aggressive tool-result offload BEFORE summarizing. Forces
  // additional large tool results to be persisted to disk so the
  // compaction call itself sees a smaller payload. State mutation
  // persists into subsequent normal requests (intentional — disk
  // persistence is a one-way decision).
  const aggressivelyOffloaded = await applyToolResultBudget(
    prepared.messages,
    toolUseContext.contentReplacementState,
    undefined, // don't write to transcript here — recovery path is best-effort
    undefined, // no skipToolNames override
    { forcedPerMessageLimit: REACTIVE_AGGRESSIVE_OFFLOAD_LIMIT },
  )
  const preparedAfterOffload = {
    messages: aggressivelyOffloaded,
    strippedOlderMedia: prepared.strippedOlderMedia,
  }

  try {
    const result = await deps.compactConversation(
      preparedAfterOffload.messages,
      toolUseContext,
      {
        ...cacheSafeParams,
        forkContextMessages: preparedAfterOffload.messages,
      },
      true,
      options.customInstructions,
      options.trigger === 'auto',
    )

    deps.setLastSummarizedMessageId(undefined)
    deps.runPostCompactCleanup()
    deps.suppressCompactWarning()
    deps.clearUserContextCache()

    logEvent('tengu_reactive_compact_succeeded', {
      triggerAuto: options.trigger === 'auto',
      strippedOlderMedia: preparedAfterOffload.strippedOlderMedia,
      preCompactTokenCount: result.preCompactTokenCount,
      truePostCompactTokenCount: result.truePostCompactTokenCount,
    })

    return { ok: true, result }
  } catch (error) {
    if (toolUseContext.abortController.signal.aborted) {
      return { ok: false, reason: 'aborted' }
    }
    // PR H: surface diagnostic information on reactive compact failure
    // so callers/operators can see which messages contributed most to
    // the overflow. Plan called this "surface top contributors via
    // TokenLedger"; we use the rough estimator directly here to avoid a
    // circular import (TokenLedger lives in services/context).
    surfaceFailureDiagnostics(preparedAfterOffload.messages, error)
    logError(error)
    return { ok: false, reason: 'error' }
  }
}

/**
 * PR H: emit a structured log of the top message-size contributors at
 * the time reactive compact failed. Helps operators identify why the
 * recovery path couldn't shrink context enough.
 *
 * Caps at 5 contributors. Each entry reports (type, tokenEstimate,
 * preview-length) without any message content to avoid leaking prompt
 * data through telemetry.
 */
function surfaceFailureDiagnostics(messages: Message[], error: unknown): void {
  try {
    const ranked = messages
      .map((message, index) => ({
        index,
        type: message.type,
        tokens: roughTokenCountEstimationForMessages([message]),
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
    const totalTokens = messages.reduce(
      (sum, m) => sum + roughTokenCountEstimationForMessages([m]),
      0,
    )
    logEvent('tengu_reactive_compact_top_contributors', {
      totalMessages: messages.length,
      totalTokens,
      top1Tokens: ranked[0]?.tokens ?? 0,
      top2Tokens: ranked[1]?.tokens ?? 0,
      top3Tokens: ranked[2]?.tokens ?? 0,
      errorIsApiError:
        typeof error === 'object' &&
        error !== null &&
        'isApiErrorMessage' in error,
    })
  } catch {
    // Diagnostics must never throw — they are a best-effort observability
    // signal, not a correctness primitive.
  }
}

export function prepareReactiveMessages(
  messages: Message[],
  context: ToolUseContext,
  stripImagesFromMessages = defaultStripImagesFromMessages,
): PreparedReactiveMessages {
  const tailSelection = selectTailForCompaction(
    messages,
    getCompactionConfig(context.options.mainLoopModel).tail,
    roughTokenCountEstimationForMessages,
  )
  if (tailSelection.prefixToSummarize.length === 0) {
    return { messages, strippedOlderMedia: false }
  }

  const strippedPrefix = stripImagesFromMessages(tailSelection.prefixToSummarize)
  const strippedOlderMedia = strippedPrefix.some(
    (message, index) => message !== tailSelection.prefixToSummarize[index],
  )
  return {
    messages: [...strippedPrefix, ...tailSelection.tailToKeep],
    strippedOlderMedia,
  }
}

function isAssistantMessageLike(
  message: unknown,
): message is Parameters<typeof isPromptTooLongMessage>[0] {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'assistant'
  )
}
