import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
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
})
