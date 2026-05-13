import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  _setGlobalConfigCacheForTesting,
  getGlobalConfig,
} from '../../utils/config.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

const originalMaxOutputTokens = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
const originalSmCompact = process.env.ENABLE_CLAUDE_CODE_SM_COMPACT
const originalDisableSmCompact = process.env.DISABLE_CLAUDE_CODE_SM_COMPACT
const originalGlobalConfig = getGlobalConfig()

let responses: Array<'max_output' | 'success'> = []
let prompts: string[] = []
let maxOutputTokenOverrides: unknown[] = []

const queryModelWithStreaming = mock(async function* ({
  messages,
  options,
}: {
  messages: Message[]
  options: { maxOutputTokensOverride?: number }
}) {
  const lastMessage = messages.at(-1)
  const content = lastMessage?.type === 'user' ? lastMessage.message.content : ''
  prompts.push(typeof content === 'string' ? content : JSON.stringify(content))
  maxOutputTokenOverrides.push(options.maxOutputTokensOverride)

  const response = responses.shift()
  if (response === 'max_output') {
    yield createAssistantAPIErrorMessage({
      content: 'API Error: The model response exceeded the output token maximum.',
      apiError: 'max_output_tokens',
      error: 'max_output_tokens',
    })
    return
  }

  yield createAssistantMessage({
    content: '<summary>short continuation state</summary>',
  })
})

mock.module('../api/claude.js', () => ({
  getMaxOutputTokensForModel: () => 20_000,
  queryModelWithStreaming,
}))

mock.module('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))

mock.module('../analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('../../utils/sessionStart.js', () => ({
  processSessionStartHooks: async () => [],
}))

mock.module('../../utils/sessionStorage.js', () => ({
  getTranscriptPath: () => '/tmp/transcript.jsonl',
  reAppendSessionMetadata: () => {},
}))

mock.module('../../utils/toolSearch.js', () => ({
  extractDiscoveredToolNames: () => new Set<string>(),
  isToolSearchEnabled: async () => false,
}))

const {
  compactConversation,
  ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT,
  partialCompactConversation,
} = await import('./compact.js')
const { forceAutoCompact } = await import('./autoCompact.js')

afterAll(() => {
  mock.restore()
})

const message = createUserMessage({ content: 'hello' })

function createContext(notifications: unknown[] = []): ToolUseContext {
  return {
    abortController: new AbortController(),
    agentId: 'agent-1',
    options: {
      mainLoopModel: 'gpt-5.5',
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      isNonInteractiveSession: true,
      querySource: 'compact',
    },
    getAppState: () => ({
      effortValue: undefined,
      tasks: {},
      toolPermissionContext: {
        additionalWorkingDirectories: new Map(),
        mode: 'default',
      },
    }),
    readFileState: createFileStateCacheWithSizeLimit(10),
    mediaReadState: new Map(),
    loadedNestedMemoryPaths: new Set(),
    addNotification: notification => notifications.push(notification),
    onCompactProgress: () => {},
    setResponseLength: () => {},
    setSDKStatus: () => {},
    setStreamMode: () => {},
  } as unknown as ToolUseContext
}

async function runCompact() {
  const context = createContext()
  return await compactConversation(
    [message],
    context,
    {
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: [message],
    },
    false,
    undefined,
    false,
    undefined,
    {},
  )
}

async function runPartialCompact(direction: 'from' | 'up_to' = 'from') {
  const context = createContext()
  const allMessages = [
    createUserMessage({ content: 'kept context' }),
    createUserMessage({ content: 'summarized context' }),
  ]
  return await partialCompactConversation(
    allMessages,
    1,
    context,
    {
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: allMessages,
    },
    undefined,
    direction,
  )
}

async function runForceAutoCompact(notifications: unknown[]) {
  const context = createContext(notifications)
  return await forceAutoCompact(
    [message],
    context,
    {
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      toolUseContext: context,
      forkContextMessages: [message],
    },
    'user',
    {
      compacted: false,
      turnCounter: 2,
      turnId: 'turn-1',
      consecutiveFailures: 1,
    },
  )
}

describe('compact output-limit recovery', () => {
  beforeEach(() => {
    responses = []
    prompts = []
    maxOutputTokenOverrides = []
    delete process.env.ENABLE_CLAUDE_CODE_SM_COMPACT
    process.env.DISABLE_CLAUDE_CODE_SM_COMPACT = 'true'
    _setGlobalConfigCacheForTesting({
      ...originalGlobalConfig,
      autoCompactEnabled: true,
    })
    queryModelWithStreaming.mockClear()
  })

  afterEach(() => {
    if (originalMaxOutputTokens === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = originalMaxOutputTokens
    }
    if (originalSmCompact === undefined) {
      delete process.env.ENABLE_CLAUDE_CODE_SM_COMPACT
    } else {
      process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = originalSmCompact
    }
    if (originalDisableSmCompact === undefined) {
      delete process.env.DISABLE_CLAUDE_CODE_SM_COMPACT
    } else {
      process.env.DISABLE_CLAUDE_CODE_SM_COMPACT = originalDisableSmCompact
    }
    _setGlobalConfigCacheForTesting(originalGlobalConfig)
  })

  test('retries with emergency compact prompt after max output', async () => {
    responses = ['max_output', 'success']

    const result = await runCompact()

    expect(queryModelWithStreaming).toHaveBeenCalledTimes(2)
    expect(prompts[0]).toContain('Keep the summary under 8,000 tokens')
    expect(prompts[1]).toContain('EMERGENCY COMPACTION RETRY')
    expect(prompts[1]).toContain('Stay under 4,000 tokens')
    expect(result.summaryMessages[0]?.message.content).toContain(
      'short continuation state',
    )
  })

  test('throws a compact-specific error if emergency retry also hits max output', async () => {
    responses = ['max_output', 'max_output']

    await expect(runCompact()).rejects.toThrow(ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT)
  })

  test('partial compact retries with direction-aware emergency prompt after max output', async () => {
    responses = ['max_output', 'success']

    const result = await runPartialCompact('up_to')

    expect(queryModelWithStreaming).toHaveBeenCalledTimes(2)
    expect(prompts[1]).toContain('EMERGENCY COMPACTION RETRY')
    expect(prompts[1]).toContain('Scope: summarize only the older prefix')
    expect(result.summaryMessages[0]?.message.content).toContain(
      'short continuation state',
    )
  })

  test('partial compact throws compact-specific error if emergency retry also hits max output', async () => {
    responses = ['max_output', 'max_output']

    await expect(runPartialCompact()).rejects.toThrow(
      ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT,
    )
  })

  test('auto-compact notifies and records failure when emergency retry hits max output', async () => {
    responses = ['max_output', 'max_output']
    const notifications: unknown[] = []

    const result = await runForceAutoCompact(notifications)

    expect(result).toEqual({ wasCompacted: false, consecutiveFailures: 2 })
    expect(queryModelWithStreaming).toHaveBeenCalledTimes(2)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      key: 'autocompact-output-limit',
      color: 'error',
      priority: 'high',
      timeoutMs: 12_000,
    })
    expect(String((notifications[0] as { text?: unknown }).text)).toContain(
      ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT,
    )
  })

  test('ignores invalid compact max-output env override', async () => {
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = 'not-a-number'
    responses = ['success']

    await runCompact()

    expect(maxOutputTokenOverrides).toEqual([20_000])
  })
})
