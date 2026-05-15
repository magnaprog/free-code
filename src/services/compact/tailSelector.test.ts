import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { createCompactBoundaryMessage } from '../../utils/messages.js'
import {
  adjustIndexToPreserveAPIInvariants,
  selectTailForCompaction,
} from './tailSelector.js'

function userText(text: string): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text },
  } as Message
}

function assistantText(text: string, messageId = 'assistant-1'): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      role: 'assistant',
      model: 'test',
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'text', text }],
    },
  } as Message
}

function assistantToolUse(id: string, messageId = 'assistant-1'): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: messageId,
      role: 'assistant',
      model: 'test',
      stop_reason: null,
      stop_sequence: null,
      type: 'message',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: 'tool_use', id, name: 'Read', input: {} }],
    },
  } as Message
}

function userToolResult(id: string): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  } as Message
}

function compactBoundary(): Message {
  return createCompactBoundaryMessage('manual', 1000) as Message
}

describe('tailSelector', () => {
  test('expands tail start to preserve tool_use/tool_result pairs', () => {
    const messages = [userText('old'), assistantToolUse('tool-1'), userToolResult('tool-1')]

    expect(adjustIndexToPreserveAPIInvariants(messages, 2)).toBe(1)
  })

  test('selects a bounded recent tail and returns prefix to summarize', () => {
    const messages = [
      userText('one'),
      userText('two'),
      userText('three'),
      userText('four'),
    ]

    const selected = selectTailForCompaction(
      messages,
      {
        minTokens: 1,
        targetTokens: 2,
        maxTokens: 3,
        minTextMessages: 2,
      },
      () => 1,
    )

    expect(selected.prefixToSummarize).toHaveLength(2)
    expect(selected.tailToKeep).toHaveLength(2)
    expect(selected.startIndex).toBe(2)
  })

  // B1: prefix must start at floor (after prior boundary), not at index 0.
  test('prefixToSummarize starts after prior compact boundary, not from index 0', () => {
    const messages = [
      userText('pre-boundary-1'),
      userText('pre-boundary-2'),
      compactBoundary(),
      userText('post-1'),
      userText('post-2'),
      userText('post-3'),
      userText('post-4'),
    ]

    const selected = selectTailForCompaction(
      messages,
      {
        minTokens: 1,
        targetTokens: 2,
        maxTokens: 4,
        minTextMessages: 2,
      },
      () => 1,
    )

    // Pre-boundary messages MUST NOT appear in prefix.
    expect(selected.prefixToSummarize).not.toContain(messages[0])
    expect(selected.prefixToSummarize).not.toContain(messages[1])
    expect(selected.prefixToSummarize).not.toContain(messages[2]) // boundary itself
    // Prefix should consist of post-boundary messages selected for summarization.
    expect(selected.prefixToSummarize.length).toBeGreaterThan(0)
    expect(selected.startIndex).toBeGreaterThanOrEqual(3)
  })

  // B2: invariant walker must not descend past floor even when the only
  // matching tool_use sits pre-boundary (orphan from prior compaction).
  test('adjustIndexToPreserveAPIInvariants does not descend past floor', () => {
    const messages = [
      assistantToolUse('orphan-tool-X', 'asst-old'), // 0 — PRE-boundary tool_use
      compactBoundary(),                              // 1 — boundary
      userToolResult('orphan-tool-X'),                // 2 — POST-boundary orphan result
    ]

    // floor = 2 (boundary index 1 + 1). With floor clamp, walker cannot drag
    // index 0 (pre-boundary tool_use) into the kept tail. Returns 2 (no change).
    const adjustedWithFloor = adjustIndexToPreserveAPIInvariants(messages, 2, 2)
    expect(adjustedWithFloor).toBe(2)

    // Sanity: without floor, walker WOULD pull index back to 0.
    const adjustedNoFloor = adjustIndexToPreserveAPIInvariants(messages, 2, 0)
    expect(adjustedNoFloor).toBe(0)
  })

  // B3: maxTokens hard cap breaks regardless of soft minimums.
  test('hard cap breaks loop when tail overshoots maxTokens × 1.5', () => {
    // 10 messages, each costing 1000 tokens. minTextMessages=20 is unreachable,
    // so soft cap can never trigger. Without hard cap, loop runs to floor=0.
    const messages = Array.from({ length: 10 }, (_, i) => userText(`msg-${i}`))

    const selected = selectTailForCompaction(
      messages,
      {
        minTokens: 100,
        targetTokens: 100,
        maxTokens: 1000, // hard cap at 1500
        minTextMessages: 20, // unreachable
      },
      () => 1000,
    )

    expect(selected.reasons).toContain('max_tokens_hard')
    // Should keep at most 1 message (1000 tokens), since adding a 2nd would
    // overshoot 1500 hard cap.
    expect(selected.tailToKeep.length).toBeLessThanOrEqual(2)
  })

  // B11 supporting case: when prefix covers entire conversation, prefix is empty.
  test('empty prefix when tail covers all messages', () => {
    const messages = [userText('one'), userText('two'), userText('three')]

    const selected = selectTailForCompaction(
      messages,
      {
        minTokens: 1,
        targetTokens: 100,
        maxTokens: 1000,
        minTextMessages: 1,
      },
      () => 1,
    )

    // All messages fit within target; loop runs to floor=0; prefix is empty.
    expect(selected.prefixToSummarize).toHaveLength(0)
    expect(selected.tailToKeep).toHaveLength(3)
    expect(selected.reasons).toContain('boundary_floor')
  })

  // Parallel tool calls: assistant message with multiple tool_use blocks,
  // user message with multiple tool_result blocks → all pairs preserved.
  test('preserves parallel tool calls across same message', () => {
    const messages = [
      userText('old'),
      // Assistant with two tool_use in one message
      {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          id: 'asst-parallel',
          role: 'assistant',
          model: 'test',
          stop_reason: null,
          stop_sequence: null,
          type: 'message',
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [
            { type: 'tool_use', id: 'tool-A', name: 'Read', input: {} },
            { type: 'tool_use', id: 'tool-B', name: 'Read', input: {} },
          ],
        },
      } as Message,
      // User with two tool_results in one message
      {
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-A', content: 'a' },
            { type: 'tool_result', tool_use_id: 'tool-B', content: 'b' },
          ],
        },
      } as Message,
    ]

    // startIndex=2 (user tool_results) without assistant tool_uses would orphan both.
    const adjusted = adjustIndexToPreserveAPIInvariants(messages, 2)
    expect(adjusted).toBe(1) // pulled back to include assistant
  })

  // Same message.id chain: assistant fragments with same message.id must
  // be preserved together (typical streaming/thinking/tool_use sequence).
  test('preserves same message.id assistant fragment chain', () => {
    const messages = [
      userText('user-old'),
      assistantText('thinking part', 'asst-same-id'),
      assistantText('text part', 'asst-same-id'),
      assistantToolUse('tool-x', 'asst-same-id'),
      userToolResult('tool-x'),
    ]

    // startIndex=4 (user toolResult) → must pull back through entire 'asst-same-id' chain.
    const adjusted = adjustIndexToPreserveAPIInvariants(messages, 4)
    // Must include all three same-id assistant fragments.
    expect(adjusted).toBeLessThanOrEqual(1)
  })

  // Session-memory compact equivalence: with floor=0 (default), behavior
  // must match pre-PR behavior (descent allowed to index 0).
  test('default floor=0 preserves legacy descent behavior', () => {
    const messages = [
      assistantToolUse('legacy-tool'),    // 0
      userText('intermediate'),            // 1
      userToolResult('legacy-tool'),       // 2
    ]

    // Without floor (i.e. floor=0), walker pulls index 2 back to index 0
    // (the assistant tool_use). Session-memory callers rely on this.
    expect(adjustIndexToPreserveAPIInvariants(messages, 2)).toBe(0)
  })
})
