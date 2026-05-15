import type { Message } from '../../types/message.js'
import { isCompactBoundaryMessage } from '../../utils/messages.js'

export type TailSelectionConfig = {
  minTokens: number
  targetTokens: number
  maxTokens: number
  minTextMessages: number
}

export type TailSelection = {
  prefixToSummarize: Message[]
  tailToKeep: Message[]
  startIndex: number
  reasons: string[]
}

type TokenCounter = (messages: Message[]) => number

export function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = message.message.content
    return content.some(block => block.type === 'text')
  }
  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') return content.length > 0
    if (Array.isArray(content)) return content.some(block => block.type === 'text')
  }
  return false
}

function getToolResultIds(message: Message): string[] {
  if (message.type !== 'user') return []
  const content = message.message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    if (block.type === 'tool_result') ids.push(block.tool_use_id)
  }
  return ids
}

function hasToolUseWithIds(message: Message, toolUseIds: Set<string>): boolean {
  if (message.type !== 'assistant') return false
  const content = message.message.content
  if (!Array.isArray(content)) return false
  return content.some(
    block => block.type === 'tool_use' && toolUseIds.has(block.id),
  )
}

export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
  floor: number = 0,
): number {
  if (startIndex <= floor || startIndex >= messages.length) return startIndex

  let adjustedIndex = startIndex
  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  if (allToolResultIds.length > 0) {
    const toolUseIdsInKeptRange = new Set<string>()
    for (let i = adjustedIndex; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') toolUseIdsInKeptRange.add(block.id)
        }
      }
    }

    const neededToolUseIds = new Set(
      allToolResultIds.filter(id => !toolUseIdsInKeptRange.has(id)),
    )
    // Clamp descent at `floor` so we never drag prior compact boundary or
    // pre-boundary content into the kept tail.
    for (let i = adjustedIndex - 1; i >= floor && neededToolUseIds.size > 0; i--) {
      const message = messages[i]!
      if (!hasToolUseWithIds(message, neededToolUseIds)) continue
      adjustedIndex = i
      if (message.type === 'assistant' && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') neededToolUseIds.delete(block.id)
        }
      }
    }
  }

  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message.id) {
      messageIdsInKeptRange.add(msg.message.id)
    }
  }

  for (let i = adjustedIndex - 1; i >= floor; i--) {
    const message = messages[i]!
    if (
      message.type === 'assistant' &&
      message.message.id &&
      messageIdsInKeptRange.has(message.message.id)
    ) {
      adjustedIndex = i
    }
  }

  return adjustedIndex
}

export function selectTailForCompaction(
  messages: Message[],
  config: TailSelectionConfig,
  tokenCounter: TokenCounter,
): TailSelection {
  if (messages.length === 0) {
    return {
      prefixToSummarize: [],
      tailToKeep: [],
      startIndex: 0,
      reasons: ['empty'],
    }
  }

  const boundaryIndex = messages.findLastIndex(m => isCompactBoundaryMessage(m))
  const floor = boundaryIndex === -1 ? 0 : boundaryIndex + 1
  let startIndex = messages.length
  let totalTokens = 0
  let textMessages = 0
  const reasons: string[] = []

  // Hard cap multiplier — break unconditionally if tail would overshoot
  // maxTokens by this factor. Prevents tool-result-heavy histories (few
  // text messages) from running away when soft minimums are not yet met.
  const HARD_CAP_MULTIPLIER = 1.5

  for (let i = messages.length - 1; i >= floor; i--) {
    const message = messages[i]!
    const messageTokens = tokenCounter([message])

    // Hard cap: break regardless of soft minimums.
    if (
      startIndex < messages.length &&
      totalTokens + messageTokens > config.maxTokens * HARD_CAP_MULTIPLIER
    ) {
      reasons.push('max_tokens_hard')
      break
    }

    const wouldExceedMax =
      startIndex < messages.length && totalTokens + messageTokens > config.maxTokens
    if (
      wouldExceedMax &&
      totalTokens >= config.minTokens &&
      textMessages >= config.minTextMessages
    ) {
      reasons.push('max_tokens')
      break
    }

    totalTokens += messageTokens
    if (hasTextBlocks(message)) textMessages++
    startIndex = i

    if (
      totalTokens >= config.targetTokens &&
      textMessages >= config.minTextMessages
    ) {
      reasons.push('target_reached')
      break
    }
  }

  const adjustedStartIndex = adjustIndexToPreserveAPIInvariants(
    messages,
    startIndex,
    floor,
  )
  if (adjustedStartIndex !== startIndex) reasons.push('api_invariants')
  if (adjustedStartIndex === floor) reasons.push('boundary_floor')

  // Slice from `floor`, not 0. Prior compact boundary and its summary stay
  // out of the prefix; otherwise each subsequent compact would re-summarize
  // the prior summary and inflate context.
  return {
    prefixToSummarize: messages.slice(floor, adjustedStartIndex),
    tailToKeep: messages.slice(adjustedStartIndex),
    startIndex: adjustedStartIndex,
    reasons,
  }
}
