import { afterEach, describe, expect, test } from 'bun:test'
import { isLoggableMessage } from './sessionStorage.js'

const originalUserType = process.env.USER_TYPE
const originalSaveHookContext = process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT

afterEach(() => {
  if (originalUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = originalUserType

  if (originalSaveHookContext === undefined) {
    delete process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT
  } else {
    process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT = originalSaveHookContext
  }
})

describe('session transcript loggability', () => {
  test('allows structural cache delta attachments for external users', () => {
    process.env.USER_TYPE = 'external'

    expect(
      isLoggableMessage({
        type: 'attachment',
        attachment: {
          type: 'deferred_tools_delta',
          addedNames: ['Read'],
          addedLines: ['Read: available via ToolSearch'],
          removedNames: [],
        },
      } as any),
    ).toBe(true)

    expect(
      isLoggableMessage({
        type: 'attachment',
        attachment: {
          type: 'mcp_instructions_delta',
          addedNames: ['server'],
          addedBlocks: ['## server\ninstructions'],
          removedNames: [],
        },
      } as any),
    ).toBe(true)
  })

  test('continues filtering unrelated attachments for external users', () => {
    process.env.USER_TYPE = 'external'

    expect(
      isLoggableMessage({
        type: 'attachment',
        attachment: { type: 'tool_use_error', content: 'hidden' },
      } as any),
    ).toBe(false)
  })

  test('preserves hook additional context opt-in behavior', () => {
    process.env.USER_TYPE = 'external'
    delete process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT

    const message = {
      type: 'attachment',
      attachment: { type: 'hook_additional_context', content: 'hook output' },
    } as any

    expect(isLoggableMessage(message)).toBe(false)

    process.env.CLAUDE_CODE_SAVE_HOOK_ADDITIONAL_CONTEXT = 'true'
    expect(isLoggableMessage(message)).toBe(true)
  })
})
