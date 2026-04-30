import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  addRepeatedToolErrorGuidance,
  countMatchingToolUseErrors,
  normalizeToolUseErrorContent,
} from './toolExecution.js'

function toolError(content: string): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID() as `${string}-${string}-${string}-${string}-${string}`,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_test',
          is_error: true,
          content: `<tool_use_error>${content}</tool_use_error>`,
        },
      ],
    },
  } as Message
}

describe('repeated tool error guidance', () => {
  test('normalizes existing repeat guidance when matching errors', () => {
    const error = 'InputValidationError: missing required field'
    const first = addRepeatedToolErrorGuidance([toolError(error), toolError(error)], error)

    expect(first.isRepeated).toBe(true)
    expect(first.repeatCount).toBe(3)
    expect(normalizeToolUseErrorContent(first.content)).toBe(
      normalizeToolUseErrorContent(error),
    )
  })

  test('does not add guidance before the repeat threshold', () => {
    const error = 'InputValidationError: missing required field'
    const result = addRepeatedToolErrorGuidance([toolError(error)], error)

    expect(result.isRepeated).toBe(false)
    expect(result.repeatCount).toBe(2)
    expect(result.content).toBe(error)
  })

  test('counts only matching tool errors', () => {
    const error = 'InputValidationError: missing required field'
    const other = 'InputValidationError: wrong type for field'

    expect(countMatchingToolUseErrors([toolError(error), toolError(other)], error)).toBe(1)
  })
})
