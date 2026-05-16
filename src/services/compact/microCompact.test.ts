/**
 * Verify `estimateMessageTokens` — the function used across compaction
 * threshold decisions (autocompact, postCompactBudget,
 * sessionMemoryCompact, compact.outputLimit) to decide whether a set
 * of messages is large enough to trigger or worth compacting.
 *
 * The function sums per-block token estimates and applies a fixed
 * 4/3 conservative-padding multiplier. Bugs here cascade: an over-
 * estimate triggers unnecessary compaction; an under-estimate misses
 * a needed compaction.
 *
 * Coverage focuses on the per-block-type branches inside the inner
 * loop. The summation + padding multiplier is verified end-to-end
 * for one representative case.
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { estimateMessageTokens } from './microCompact.js'

// `roughTokenCountEstimation` returns ceil(content.length / 4) by default
// (see services/tokenEstimation.ts). All assertions below use the
// derived value rather than hardcoded magic numbers so a refactor of
// the underlying estimator stays consistent.
function roughTokens(text: string): number {
  return Math.round(text.length / 4)
}

function applyPadding(tokens: number): number {
  return Math.ceil(tokens * (4 / 3))
}

function userMessageWithBlocks(blocks: unknown[]): Message {
  return {
    type: 'user',
    uuid: 'test-uuid',
    timestamp: '2026-05-15T00:00:00.000Z',
    message: { role: 'user', content: blocks as never },
  } as unknown as Message
}

function assistantMessageWithBlocks(blocks: unknown[]): Message {
  return {
    type: 'assistant',
    uuid: 'test-uuid',
    timestamp: '2026-05-15T00:00:00.000Z',
    message: { role: 'assistant', content: blocks as never, id: 'msg-1' },
  } as unknown as Message
}

describe('estimateMessageTokens', () => {
  test('returns 0 for empty message list', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  test('skips non-user/assistant message types', () => {
    const progressMsg = {
      type: 'progress',
      uuid: 'x',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    } as unknown as Message
    expect(estimateMessageTokens([progressMsg])).toBe(0)
  })

  test('counts string-shorthand content (used by session-memory summary)', () => {
    // Session-memory compact calls createUserMessage with string content,
    // then uses estimateMessageTokens for post-compact threshold checks.
    // The previous skip-non-array behavior returned 0 here, masking the
    // summary size — fixed so the string is counted directly.
    const text = 'this is a string, not an array'
    const strMsg = {
      type: 'user',
      uuid: 'x',
      message: { role: 'user', content: text },
    } as unknown as Message
    expect(estimateMessageTokens([strMsg])).toBe(applyPadding(roughTokens(text)))
  })

  test('skips messages with null/undefined content (truly non-string non-array)', () => {
    // Defensive: a malformed message with neither string nor array content.
    const nullMsg = {
      type: 'user',
      uuid: 'x',
      message: { role: 'user', content: null },
    } as unknown as Message
    expect(estimateMessageTokens([nullMsg])).toBe(0)
  })

  test('counts text blocks via roughTokenCountEstimation', () => {
    // 16 chars → ~4 tokens, then 4/3 padding → 6.
    const msg = userMessageWithBlocks([{ type: 'text', text: 'a'.repeat(16) }])
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens('a'.repeat(16))))
  })

  test('counts thinking blocks by thinking field only, not signature', () => {
    // The function reads block.thinking, NOT block.signature. A bug that
    // accidentally counts the signature would inflate token estimates.
    const msg = assistantMessageWithBlocks([
      {
        type: 'thinking',
        thinking: 'a'.repeat(40),
        signature: 'b'.repeat(10_000), // would dominate if counted by mistake
      },
    ])
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens('a'.repeat(40))))
  })

  test('counts redacted_thinking by data field', () => {
    const msg = assistantMessageWithBlocks([
      { type: 'redacted_thinking', data: 'a'.repeat(20) },
    ])
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens('a'.repeat(20))))
  })

  test('counts tool_use by name + JSON(input), not the id/wrapper', () => {
    const block = {
      type: 'tool_use',
      id: 'toolu_01ABCDEF', // should NOT be counted
      name: 'Bash',
      input: { command: 'ls' },
    }
    const msg = assistantMessageWithBlocks([block])
    const expectedStr = 'Bash' + JSON.stringify({ command: 'ls' })
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens(expectedStr)))
  })

  test('tool_use with no input still counts the name', () => {
    // block.input ?? {} → JSON.stringify({}) = '{}'.
    const block = { type: 'tool_use', id: 'x', name: 'ReadAll' }
    const msg = assistantMessageWithBlocks([block])
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens('ReadAll{}')))
  })

  test('counts image and document blocks with fixed IMAGE_MAX_TOKEN_SIZE (2000)', () => {
    // The constant is internal; assert via the 4/3 padded value: 2000 * 4/3 = 2667.
    const imgMsg = userMessageWithBlocks([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } },
    ])
    expect(estimateMessageTokens([imgMsg])).toBe(applyPadding(2000))

    const docMsg = userMessageWithBlocks([
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'xyz' } },
    ])
    expect(estimateMessageTokens([docMsg])).toBe(applyPadding(2000))
  })

  test('counts tool_result string content by length', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 'toolu_x',
      content: 'output text here',
    }
    const msg = userMessageWithBlocks([block])
    expect(estimateMessageTokens([msg])).toBe(applyPadding(roughTokens('output text here')))
  })

  test('counts tool_result array content (text + image mix)', () => {
    const block = {
      type: 'tool_result',
      tool_use_id: 'toolu_x',
      content: [
        { type: 'text', text: 'a'.repeat(32) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xyz' } },
      ],
    }
    const msg = userMessageWithBlocks([block])
    expect(estimateMessageTokens([msg])).toBe(
      applyPadding(roughTokens('a'.repeat(32)) + 2000),
    )
  })

  test('falls back to JSON.stringify for unknown block types', () => {
    // server_tool_use / web_search_tool_result etc. fall through to a
    // catch-all JSON.stringify(block) length estimate.
    const block = {
      type: 'server_tool_use',
      id: 'srv_1',
      name: 'web_search',
      input: { q: 'foo' },
    }
    const msg = assistantMessageWithBlocks([block])
    // Length-via-JSON estimate; assert deterministic match.
    const expected = applyPadding(roughTokens(JSON.stringify(block)))
    expect(estimateMessageTokens([msg])).toBe(expected)
  })

  test('sums across multiple messages and multiple blocks', () => {
    const messages = [
      userMessageWithBlocks([{ type: 'text', text: 'a'.repeat(20) }]),
      assistantMessageWithBlocks([
        { type: 'text', text: 'b'.repeat(40) },
        { type: 'thinking', thinking: 'c'.repeat(16), signature: 'sig' },
      ]),
    ]
    const inner =
      roughTokens('a'.repeat(20)) +
      roughTokens('b'.repeat(40)) +
      roughTokens('c'.repeat(16))
    expect(estimateMessageTokens(messages)).toBe(applyPadding(inner))
  })

  test('padding multiplier is 4/3 (ceil) — conservative over-estimate', () => {
    // One char → roughTokens 0 (Math.round(1/4)=0) → padded ceil(0*4/3) = 0.
    // 4 chars → roughTokens 1 → ceil(1 * 4/3) = 2.
    // 12 chars → roughTokens 3 → ceil(3 * 4/3) = 4.
    expect(
      estimateMessageTokens([
        userMessageWithBlocks([{ type: 'text', text: 'a'.repeat(4) }]),
      ]),
    ).toBe(2)
    expect(
      estimateMessageTokens([
        userMessageWithBlocks([{ type: 'text', text: 'a'.repeat(12) }]),
      ]),
    ).toBe(4)
  })
})
