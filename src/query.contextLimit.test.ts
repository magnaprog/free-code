import { describe, expect, test } from 'bun:test'
import { query } from './query.js'
import type { QueryDeps } from './query/deps.js'
import {
  createAssistantAPIErrorMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from './utils/messages.js'

async function drain<T>(gen: AsyncGenerator<T, unknown>): Promise<T[]> {
  const out: T[] = []
  for (;;) {
    const next = await gen.next()
    if (next.done) return out
    out.push(next.value)
  }
}

function toolUseContext(): any {
  const abortController = new AbortController()
  return {
    abortController,
    options: {
      mainLoopModel: 'gpt-5.5',
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      isNonInteractiveSession: true,
      querySource: 'repl_main_thread',
    },
    getAppState: () => ({
      toolPermissionContext: {
        mode: 'default',
        alwaysAllowRules: { command: {} },
        additionalWorkingDirectories: new Map(),
      },
      effortValue: undefined,
      tasks: {},
      mcp: { tools: [], clients: [] },
      sessionHooks: new Map(),
    }),
    readFileState: new Map(),
    mediaReadState: new Map(),
    loadedNestedMemoryPaths: new Set(),
  }
}

describe('query context-limit recovery', () => {
  test('withholds context-limit errors, force-compacts once, and retries', async () => {
    let callCount = 0
    let forceCompactCount = 0
    const initial = createUserMessage({ content: 'hello' })
    const summary = createUserMessage({
      content: 'compact summary',
      isCompactSummary: true,
    })
    const boundary = createCompactBoundaryMessage('auto', 100, initial.uuid)

    const deps: QueryDeps = {
      uuid: () => `uuid-${forceCompactCount}`,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({ wasCompacted: false }),
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
      callModel: async function* () {
        callCount += 1
        if (callCount === 1) {
          yield createAssistantAPIErrorMessage({
            content: 'Prompt is too long',
            error: 'invalid_request',
            errorDetails: 'context_length_exceeded',
          })
          return
        }
        yield createAssistantAPIErrorMessage({
          content: 'API Error: retry reached model',
          error: 'unknown',
        })
      } as QueryDeps['callModel'],
    }

    const messages = await drain(
      query({
        messages: [initial],
        systemPrompt: [] as any,
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        toolUseContext: toolUseContext(),
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(callCount).toBe(2)
    expect(forceCompactCount).toBe(1)
    expect(
      messages.some(
        msg =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'assistant' &&
          'message' in msg &&
          Array.isArray((msg as any).message.content) &&
          (msg as any).message.content.some(
            (block: any) =>
              block.type === 'text' && block.text === 'Prompt is too long',
          ),
      ),
    ).toBe(false)
    expect(messages).toContain(boundary)
    expect(messages).toContain(summary)
    expect(
      messages.some(
        msg =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'assistant' &&
          'message' in msg &&
          Array.isArray((msg as any).message.content) &&
          (msg as any).message.content.some(
            (block: any) =>
              block.type === 'text' &&
              block.text === 'API Error: retry reached model',
          ),
      ),
    ).toBe(true)
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
          content: 'Prompt is too long',
          error: 'invalid_request',
          errorDetails: 'context_length_exceeded',
        })
      } as QueryDeps['callModel'],
    }

    const messages = await drain(
      query({
        messages: [createUserMessage({ content: 'summarize' })],
        systemPrompt: [] as any,
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
    expect(
      messages.some(
        msg =>
          typeof msg === 'object' &&
          msg !== null &&
          'type' in msg &&
          msg.type === 'assistant' &&
          'message' in msg &&
          Array.isArray((msg as any).message.content) &&
          (msg as any).message.content.some(
            (block: any) =>
              block.type === 'text' && block.text === 'Prompt is too long',
          ),
      ),
    ).toBe(true)
  })
})
