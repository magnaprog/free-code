/**
 * Verify `groupMessagesByApiRound` — the boundary-split function used
 * by reactive compact to find the latest API round in a conversation.
 *
 * The function's contract per its JSDoc:
 *   - A boundary fires whenever an assistant message has a NEW
 *     message.id (different from the prior assistant's id, or the
 *     first assistant after any preceding messages).
 *   - normalizeMessages yields one AssistantMessage per content block,
 *     so streaming chunks of the SAME api response share message.id
 *     and stay grouped.
 *   - tool_results (type='user') interleaved between same-id assistant
 *     chunks stay in the group.
 *
 * Implication of the boundary rule: any messages preceding the first
 * assistant form their own initial group (the bare user prompt that
 * triggered round 1). Reactive compact treats every group except the
 * final one as "older rounds" eligible for media stripping; the
 * initial user-prompt group is included in that older set, which is
 * the intent (text prompts have negligible media payload).
 */
import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import { groupMessagesByApiRound } from './grouping.js'

let counter = 0
function userMsg(text: string): Message {
  counter += 1
  return {
    type: 'user',
    uuid: `u-${counter}`,
    timestamp: '2026-05-15T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as Message
}

function assistantMsg(id: string | undefined, blocks: unknown[]): Message {
  counter += 1
  return {
    type: 'assistant',
    uuid: `a-${counter}`,
    timestamp: '2026-05-15T00:00:00.000Z',
    message: { role: 'assistant', content: blocks as never, id },
  } as unknown as Message
}

function toolResult(toolUseId: string, content: string): Message {
  counter += 1
  return {
    type: 'user',
    uuid: `t-${counter}`,
    timestamp: '2026-05-15T00:00:00.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
    },
  } as unknown as Message
}

describe('groupMessagesByApiRound', () => {
  test('returns empty array for empty input', () => {
    expect(groupMessagesByApiRound([])).toEqual([])
  })

  test('first assistant message starts a new group, isolating prior user prompt', () => {
    // Two-message conversation: bare user prompt then one assistant reply.
    // Boundary fires at the assistant because its id !== undefined AND
    // current.length > 0 (the user prompt is in current). The pre-
    // assistant prompt becomes its own group.
    const msgs = [
      userMsg('q1'),
      assistantMsg('msg-1', [{ type: 'text', text: 'a1' }]),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(1) // [user]
    expect(groups[1]).toHaveLength(1) // [assistant]
  })

  test('conversation with no preceding user message starts with assistant', () => {
    // No prior user prompt. First assistant fires the boundary check
    // but current.length is 0 → no boundary, just push into current.
    // Confirms the boundary gate's empty-current short-circuit.
    const msgs = [
      assistantMsg('msg-1', [{ type: 'text', text: 'hi' }]),
      userMsg('hello'),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(2)
  })

  test('keeps same-id assistant chunks (with interleaved tool_results) in one group', () => {
    // Streaming chunks of one API response share message.id.
    // normalizeMessages yields one AssistantMessage per content block.
    // StreamingToolExecutor interleaves tool_results live.
    // The first user msg is split off as its own initial group; the
    // entire same-id assistant round forms the second group.
    const msgs = [
      userMsg('list files'),
      assistantMsg('msg-1', [
        { type: 'tool_use', id: 'tu_A', name: 'Bash', input: {} },
      ]),
      toolResult('tu_A', 'file1.ts'),
      assistantMsg('msg-1', [
        { type: 'tool_use', id: 'tu_B', name: 'Bash', input: {} },
      ]),
      toolResult('tu_B', 'file2.ts'),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(1) // user prompt
    expect(groups[1]).toHaveLength(4) // a1+result+a1+result
  })

  test('each new assistant message.id creates a new group', () => {
    // user → asst(msg-1) → user → asst(msg-2): three boundaries' worth
    // of content. Initial user is solo; asst(msg-1) + the second user
    // form group 1; asst(msg-2) is group 2.
    const msgs = [
      userMsg('q1'),
      assistantMsg('msg-1', [{ type: 'text', text: 'a1' }]),
      userMsg('q2'),
      assistantMsg('msg-2', [{ type: 'text', text: 'a2' }]),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(3)
    expect(groups[0]).toHaveLength(1) // [q1]
    expect(groups[1]).toHaveLength(2) // [a1, q2]
    expect(groups[2]).toHaveLength(1) // [a2]
  })

  test('agentic session: 3 assistant rounds chained with tool_results', () => {
    // Single-prompt agentic session: one human turn, multiple
    // assistant rounds with tool calls between them. Each new
    // message.id starts a new round.
    const msgs = [
      userMsg('do many things'),
      assistantMsg('msg-1', [
        { type: 'tool_use', id: 'tu_A', name: 'Bash', input: {} },
      ]),
      toolResult('tu_A', 'done'),
      assistantMsg('msg-2', [
        { type: 'tool_use', id: 'tu_B', name: 'Bash', input: {} },
      ]),
      toolResult('tu_B', 'done'),
      assistantMsg('msg-3', [{ type: 'text', text: 'all done' }]),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(4)
    expect(groups[0]).toHaveLength(1) // [user prompt]
    expect(groups[1]).toHaveLength(2) // [msg-1, result-A]
    expect(groups[2]).toHaveLength(2) // [msg-2, result-B]
    expect(groups[3]).toHaveLength(1) // [msg-3]
  })

  test('undefined assistant id: stable across multiple assistants in same round', () => {
    // Defensive: malformed input where msg.message.id is undefined.
    // Strict !== means undefined → undefined is NOT a boundary
    // change. The first assistant still fires a boundary because
    // lastAssistantId starts as undefined and undefined !== undefined
    // is false, so the boundary DOESN'T fire — the user msg + both
    // undefined-id assistants stay in one group.
    const msgs = [
      userMsg('q'),
      assistantMsg(undefined, [{ type: 'text', text: 'a1' }]),
      assistantMsg(undefined, [{ type: 'text', text: 'a2' }]),
    ]
    const groups = groupMessagesByApiRound(msgs)
    // First assistant: id (undefined) !== lastAssistantId (undefined) → false.
    // So NO boundary; user + a1 + a2 all in one group.
    expect(groups).toHaveLength(1)
    expect(groups[0]).toHaveLength(3)
  })

  test('transition undefined-id → defined-id triggers boundary', () => {
    // undefined → 'msg-2' IS a strict-inequality change → boundary.
    const msgs = [
      userMsg('q'),
      assistantMsg(undefined, [{ type: 'text', text: 'a1' }]),
      assistantMsg('msg-2', [{ type: 'text', text: 'a2' }]),
    ]
    const groups = groupMessagesByApiRound(msgs)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toHaveLength(2) // [user, a1]
    expect(groups[1]).toHaveLength(1) // [a2]
  })
})
