import { feature } from 'bun:bundle'
import chalk from 'chalk'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { notifyCompaction } from '../../services/api/promptCacheBreakDetection.js'
import {
  type CompactionResult,
  type PreCompactHookResult,
  compactConversation,
  ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT,
  ERROR_MESSAGE_INCOMPLETE_RESPONSE,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_USER_ABORT,
  isPreCompactBlockedError,
  mergeHookInstructions,
  throwIfPreCompactBlocked,
} from '../../services/compact/compact.js'
import { suppressCompactWarning } from '../../services/compact/compactWarningState.js'
import { microcompactMessages } from '../../services/compact/microCompact.js'
import {
  isMainThreadQuerySource,
  runPostCompactCleanup,
} from '../../services/compact/postCompactCleanup.js'
import { trySessionMemoryCompaction } from '../../services/compact/sessionMemoryCompact.js'
import { setLastSummarizedMessageId } from '../../services/SessionMemory/sessionMemoryUtils.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalCommandCall } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import { executePreCompactHooks } from '../../utils/hooks.js'
import { logError } from '../../utils/log.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { getUpgradeMessage } from '../../utils/model/contextWindowUpgradeCheck.js'
import {
  buildEffectiveSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPrompt.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('../../services/compact/reactiveCompact.js') as typeof import('../../services/compact/reactiveCompact.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export const call: LocalCommandCall = async (args, context) => {
  const { abortController } = context
  let { messages } = context

  // REPL keeps snipped messages for UI scrollback — project so the compact
  // model doesn't summarize content that was intentionally removed.
  messages = getMessagesAfterCompactBoundary(messages)

  if (messages.length === 0) {
    throw new Error('No messages to compact')
  }

  const customInstructions = args.trim()
  let preCompactHookResult: PreCompactHookResult | undefined
  let preCompactStarted = false
  let fallbackOwnsProgress = false

  try {
    if (!customInstructions) {
      preCompactStarted = true
      context.onCompactProgress?.({
        type: 'hooks_start',
        hookType: 'pre_compact',
      })
      context.setSDKStatus?.('compacting')
      preCompactHookResult = await executePreCompactHooks(
        { trigger: 'manual', customInstructions: null },
        context.abortController.signal,
      )
      throwIfPreCompactBlocked(preCompactHookResult)

      if (!preCompactHookResult.newCustomInstructions) {
        const sessionMemoryResult = await trySessionMemoryCompaction(
          messages,
          context.agentId,
          undefined,
          preCompactHookResult,
        )
        if (sessionMemoryResult) {
          // Subagent-invoked /compact must not clobber main-thread
          // module-level state. runPostCompactCleanup itself is
          // querySource-aware; mirror that gating for the
          // getUserContext cache so subagent compacts leave the main
          // thread's user-context cache intact.
          if (isMainThreadQuerySource(context.options.querySource)) {
            getUserContext.cache.clear?.()
          }
          runPostCompactCleanup(context.options.querySource)
          // Reset cache read baseline so the post-compact drop isn't flagged
          // as a break. compactConversation does this internally; SM-compact doesn't.
          if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
            notifyCompaction(
              context.options.querySource ?? 'compact',
              context.agentId,
            )
          }
          markPostCompaction()
          // Suppress warning immediately after successful compaction
          suppressCompactWarning()
          context.onCompactProgress?.({ type: 'compact_end' })
          context.setSDKStatus?.(null)

          return {
            type: 'compact',
            compactionResult: sessionMemoryResult,
            displayText: buildDisplayText(
              context,
              sessionMemoryResult.userDisplayMessage,
            ),
          }
        }
      }
    }

    // Reactive-only mode: route /compact through the reactive path.
    // Checked after session-memory (that path is cheap and orthogonal).
    if (reactiveCompact?.isReactiveOnlyMode()) {
      fallbackOwnsProgress = true
      return await compactViaReactive(
        messages,
        context,
        customInstructions,
        reactiveCompact,
        preCompactHookResult,
      )
    }

    // Fall back to traditional compaction
    // Run microcompact first to reduce tokens before summarization
    const microcompactResult = await microcompactMessages(messages, context)
    const messagesForCompact = microcompactResult.messages
    const cacheSafeParams = await getCacheSharingParams(
      context,
      messagesForCompact,
    )

    fallbackOwnsProgress = true
    const result = await compactConversation(
      messagesForCompact,
      context,
      cacheSafeParams,
      false,
      customInstructions,
      false,
      undefined,
      preCompactHookResult,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)

    // Suppress the "Context left until auto-compact" warning after successful compaction
    suppressCompactWarning()

    if (isMainThreadQuerySource(context.options.querySource)) {
      getUserContext.cache.clear?.()
    }
    runPostCompactCleanup(context.options.querySource)

    return {
      type: 'compact',
      compactionResult: result,
      displayText: buildDisplayText(context, result.userDisplayMessage),
    }
  } catch (error) {
    if (preCompactStarted && !fallbackOwnsProgress) {
      context.onCompactProgress?.({ type: 'compact_end' })
      context.setSDKStatus?.(null)
    }
    if (abortController.signal.aborted) {
      throw new Error('Compaction canceled.')
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_INCOMPLETE_RESPONSE)) {
      throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
    } else if (hasExactErrorMessage(error, ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT)) {
      throw new Error(ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT)
    } else if (isPreCompactBlockedError(error)) {
      throw error
    } else {
      logError(error)
      throw new Error(`Error during compaction: ${error}`)
    }
  }
}

async function compactViaReactive(
  messages: Message[],
  context: ToolUseContext,
  customInstructions: string,
  reactive: NonNullable<typeof reactiveCompact>,
  preCompactHookResult?: PreCompactHookResult,
): Promise<{
  type: 'compact'
  compactionResult: CompactionResult
  displayText: string
}> {
  try {
    let hookResult = preCompactHookResult
    let cacheSafeParams: Awaited<ReturnType<typeof getCacheSharingParams>>
    if (hookResult) {
      cacheSafeParams = await getCacheSharingParams(context, messages)
    } else {
      context.onCompactProgress?.({
        type: 'hooks_start',
        hookType: 'pre_compact',
      })
      context.setSDKStatus?.('compacting')
      const [executedHookResult, params] = await Promise.all([
        executePreCompactHooks(
          { trigger: 'manual', customInstructions: customInstructions || null },
          context.abortController.signal,
        ),
        getCacheSharingParams(context, messages),
      ])
      hookResult = executedHookResult
      cacheSafeParams = params
    }
    throwIfPreCompactBlocked(hookResult)
    const mergedInstructions = mergeHookInstructions(
      customInstructions,
      hookResult.newCustomInstructions,
    )

    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_start' })

    const outcome = await reactive.reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      {
        customInstructions: mergedInstructions,
        trigger: 'manual',
        querySource: context.options.querySource,
      },
    )

    if (!outcome.ok) {
      // The outer catch in `call` translates these: aborted → "Compaction
      // canceled." (via abortController.signal.aborted check), NOT_ENOUGH →
      // re-thrown as-is, everything else → "Error during compaction: …".
      switch (outcome.reason) {
        case 'too_few_groups':
          throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
        case 'aborted':
          throw new Error(ERROR_MESSAGE_USER_ABORT)
        case 'exhausted':
        case 'error':
        case 'media_unstrippable':
          throw new Error(ERROR_MESSAGE_INCOMPLETE_RESPONSE)
      }
    }

    // reactiveCompactOnPromptTooLong already ran the full post-success
    // cleanup (setLastSummarizedMessageId, runPostCompactCleanup,
    // suppressCompactWarning, clearUserContextCache). The stale comment
    // here claimed "minus resetMicrocompactState" but
    // runPostCompactCleanup does in fact reset microcompact state
    // (postCompactCleanup.ts:41), so the duplicate calls were just
    // redundant work.

    // reactiveCompactOnPromptTooLong runs PostCompact hooks but not PreCompact
    // — both callers (here and tryReactiveCompact) run PreCompact outside so
    // they can merge its userDisplayMessage with PostCompact's here. This
    // caller additionally runs it concurrently with getCacheSharingParams.
    const combinedMessage =
      [hookResult.userDisplayMessage, outcome.result.userDisplayMessage]
        .filter(Boolean)
        .join('\n') || undefined

    return {
      type: 'compact',
      compactionResult: {
        ...outcome.result,
        userDisplayMessage: combinedMessage,
      },
      displayText: buildDisplayText(context, combinedMessage),
    }
  } finally {
    context.setStreamMode?.('requesting')
    context.setResponseLength?.(() => 0)
    context.onCompactProgress?.({ type: 'compact_end' })
    context.setSDKStatus?.(null)
  }
}

function buildDisplayText(
  context: ToolUseContext,
  userDisplayMessage?: string,
): string {
  const upgradeMessage = getUpgradeMessage('tip')
  const expandShortcut = getShortcutDisplay(
    'app:toggleTranscript',
    'Global',
    'ctrl+o',
  )
  const dimmed = [
    ...(context.options.verbose
      ? []
      : [`(${expandShortcut} to see full summary)`]),
    ...(userDisplayMessage ? [userDisplayMessage] : []),
    ...(upgradeMessage ? [upgradeMessage] : []),
  ]
  return chalk.dim('Compacted ' + dimmed.join('\n'))
}

async function getCacheSharingParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<{
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}> {
  const appState = context.getAppState()
  const defaultSysPrompt = await getSystemPrompt(
    context.options.tools,
    context.options.mainLoopModel,
    Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    context.options.mcpClients,
  )
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  const [userContext, systemContext] = await Promise.all([
    getUserContext(),
    getSystemContext(),
  ])
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}
