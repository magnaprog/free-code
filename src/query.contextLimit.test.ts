import { describe, expect, test } from 'bun:test'
import {
  isPromptTooLongMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './services/api/errors.js'
import { getDefaultAppState } from './state/AppStateStore.js'
import type { ToolUseContext } from './Tool.js'
import type { AssistantMessage } from './types/message.js'
import { createFileStateCacheWithSizeLimit } from './utils/fileStateCache.js'
import { toArray } from './utils/generators.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import {
  createAssistantAPIErrorMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from './utils/messages.js'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'

function toolUseContext(): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'gpt-5.5',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      agentDefinitions: { activeAgents: [] },
      isNonInteractiveSession: true,
      querySource: 'repl_main_thread',
    },
    getAppState: () => appState,
    setAppState: () => {},
    readFileState: createFileStateCacheWithSizeLimit(10),
    mediaReadState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
  } as ToolUseContext
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'assistant'
  )
}

function hasAssistantText(messages: unknown[], text: string): boolean {
  return messages
    .filter(isAssistantMessage)
    .some(message =>
      message.message.content.some(
        block => block.type === 'text' && block.text === text,
      ),
    )
}

describe('query context-limit recovery', () => {
  test('withholds context-limit errors, force-compacts once, and retries', async () => {
    let callCount = 0
    let autoCompactCount = 0
    let forceCompactCount = 0
    let retryUsedCompactedMessages = false
    const initial = createUserMessage({ content: 'hello' })
    const summary = createUserMessage({
      content: 'compact summary',
      isCompactSummary: true,
    })
    const boundary = createCompactBoundaryMessage('auto', 100, initial.uuid)

    const deps: QueryDeps = {
      uuid: () => `uuid-${forceCompactCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => {
        autoCompactCount += 1
        return { wasCompacted: false }
      },
      forceAutocompact: async () => {
        forceCompactCount += 1
        return {
          wasCompacted: true,
          compactionResult: {
            boundaryMarker: boundary,
            summaryMessages: [summary],
            attachments: [],
            hookResults: [],
          },
        }
      },
      callModel: async function* ({ messages }) {
        callCount += 1
        if (callCount === 1) {
          yield createAssistantAPIErrorMessage({
            content: PROMPT_TOO_LONG_ERROR_MESSAGE,
            error: 'invalid_request',
            errorDetails: 'context_length_exceeded',
          })
          return
        }
        retryUsedCompactedMessages = messages.some(
          message =>
            message.type === 'system' && message.subtype === 'compact_boundary',
        )
        yield createAssistantAPIErrorMessage({
          content: 'API Error: retry reached model',
          error: 'unknown',
        })
      } as QueryDeps['callModel'],
    }

    const messages = await toArray(
      query({
        messages: [initial],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: toolUseContext(),
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(callCount).toBe(2)
    expect(autoCompactCount).toBe(1)
    expect(forceCompactCount).toBe(1)
    expect(retryUsedCompactedMessages).toBe(true)
    expect(messages.filter(isAssistantMessage).some(isPromptTooLongMessage)).toBe(
      false,
    )
    expect(messages).toContain(boundary)
    expect(messages).toContain(summary)
    expect(hasAssistantText(messages, 'API Error: retry reached model')).toBe(true)
  })

  test('does not force-compact inside compact queries', async () => {
    let callCount = 0
    let forceCompactCount = 0
    const deps: QueryDeps = {
      uuid: () => 'uuid-noop',
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
      forceAutocompact: async () => {
        forceCompactCount += 1
        return { wasCompacted: false }
      },
      callModel: async function* () {
        callCount += 1
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
          errorDetails: 'context_length_exceeded',
        })
      } as QueryDeps['callModel'],
    }

    const messages = await toArray(
      query({
        messages: [createUserMessage({ content: 'summarize' })],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: toolUseContext(),
        querySource: 'compact',
        deps,
      }),
    )

    expect(callCount).toBe(1)
    expect(forceCompactCount).toBe(0)
    expect(messages.filter(isAssistantMessage).some(isPromptTooLongMessage)).toBe(
      true,
    )
  })
})
