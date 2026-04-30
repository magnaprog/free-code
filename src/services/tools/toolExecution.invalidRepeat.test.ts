import { describe, expect, test } from 'bun:test'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  addRepeatedToolErrorGuidance,
  countMatchingToolUseErrors,
  normalizeToolUseErrorContent,
  runToolUse,
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

function createToolUseContext(messages: Message[] = []): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: () => {},
    messages,
    readFileState: createFileStateCacheWithSizeLimit(10),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as ToolUseContext
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

  test('bounds normalization of huge tool errors', () => {
    const normalized = normalizeToolUseErrorContent(
      `<tool_use_error>${'x '.repeat(10_000)}</tool_use_error>`,
    )

    expect(normalized.length).toBe(2_000)
    expect(normalized.startsWith('<tool_use_error>')).toBe(false)
  })

  test('counts matching huge tagged errors without requiring full tag extraction', () => {
    const error = 'InputValidationError: ' + 'x '.repeat(10_000)

    expect(countMatchingToolUseErrors([toolError(error)], error)).toBe(1)
  })

  test('adds guidance through the unknown tool execution path at threshold', async () => {
    const error = 'Error: No such tool available: MissingTool'
    const context = createToolUseContext([toolError(error), toolError(error)])
    const assistantMessage = createAssistantMessage({ content: [] })
    const updates = []

    for await (const update of runToolUse(
      { type: 'tool_use', id: 'toolu_missing', name: 'MissingTool', input: {} },
      assistantMessage,
      (() => {
        throw new Error('permission check should not run for unknown tools')
      }) as never,
      context,
    )) {
      updates.push(update)
    }

    expect(updates).toHaveLength(1)
    const result = updates[0]!.message
    expect(result.toolUseResult).toContain(
      'This is the same invalid tool call again.',
    )
    expect(JSON.stringify(result.message.content)).toContain(
      'This is the same invalid tool call again.',
    )
  })
})
