import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { ReactiveCompactDeps } from './reactiveCompact.js'
import * as reactive from './reactiveCompact.js'

const OLD_ENV = { ...process.env }
const compactResult = {
  boundaryMarker: {} as never,
  summaryMessages: [],
  attachments: [],
  hookResults: [],
  preCompactTokenCount: 100,
  truePostCompactTokenCount: 10,
}

beforeEach(() => {
  process.env = { ...OLD_ENV }
})

afterEach(() => {
  process.env = { ...OLD_ENV }
})

describe('reactiveCompact', () => {
  test('is env gated', () => {
    expect(reactive.isReactiveCompactEnabled()).toBe(false)

    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    expect(reactive.isReactiveCompactEnabled()).toBe(true)
    expect(reactive.isReactiveOnlyMode()).toBe(false)

    process.env.CLAUDE_CODE_REACTIVE_ONLY_COMPACT = '1'
    expect(reactive.isReactiveOnlyMode()).toBe(true)
  })

  test('detects prompt-too-long and media-size assistant errors', () => {
    expect(
      reactive.isWithheldPromptTooLong(
        assistantApiError('Prompt is too long: 10 tokens > 5 maximum'),
      ),
    ).toBe(true)
    expect(
      reactive.isWithheldMediaSizeError(
        assistantApiError('Image was too large.', 'image exceeds maximum bytes'),
      ),
    ).toBe(true)
  })

  test('guards attempted, compact sources, and aborted requests', async () => {
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()
    const cacheSafeParams = createCacheSafeParams(messages)

    expect(
      await reactive.tryReactiveCompact(
        {
          hasAttempted: true,
          querySource: 'repl_main_thread' as never,
          aborted: false,
          messages,
          cacheSafeParams,
        },
        deps,
      ),
    ).toBeNull()
    expect(
      await reactive.tryReactiveCompact(
        {
          hasAttempted: false,
          querySource: 'compact' as never,
          aborted: false,
          messages,
          cacheSafeParams,
        },
        deps,
      ),
    ).toBeNull()
    expect(
      await reactive.tryReactiveCompact(
        {
          hasAttempted: false,
          querySource: 'repl_main_thread' as never,
          aborted: true,
          messages,
          cacheSafeParams,
        },
        deps,
      ),
    ).toBeNull()
    expect(deps.compactConversation).not.toHaveBeenCalled()
  })

  test('compacts once and strips only older media before retry', async () => {
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()
    const result = await reactive.tryReactiveCompact(
      {
        hasAttempted: false,
        querySource: 'repl_main_thread' as never,
        aborted: false,
        messages,
        cacheSafeParams: createCacheSafeParams(messages),
      },
      deps,
    )

    expect(result).toBe(compactResult)
    expect(deps.compactConversation).toHaveBeenCalledTimes(1)
    const compactedMessages = deps.compactConversation.mock.calls[0]?.[0] as
      | unknown[]
      | undefined
    expect(JSON.stringify(compactedMessages?.[0])).toContain('[image]')
    expect(JSON.stringify(compactedMessages?.at(-1))).not.toContain('[image]')
    expect(deps.setLastSummarizedMessageId).toHaveBeenCalledWith(undefined)
    expect(deps.runPostCompactCleanup).toHaveBeenCalledTimes(1)
    expect(deps.suppressCompactWarning).toHaveBeenCalledTimes(1)
  })

  test('threads querySource through to runPostCompactCleanup', async () => {
    // Undefined is the main-thread default, so subagent compaction must
    // pass its querySource through to cleanup.
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()

    // Use an agent-prefixed querySource — the postCompactCleanup's
    // isMainThread check would handle this differently than undefined.
    const subagentSource = 'agent:test-agent' as never
    const result = await reactive.tryReactiveCompact(
      {
        hasAttempted: false,
        querySource: subagentSource,
        aborted: false,
        messages,
        cacheSafeParams: createCacheSafeParams(messages),
      },
      deps,
    )

    expect(result).toBe(compactResult)
    expect(deps.runPostCompactCleanup).toHaveBeenCalledWith(subagentSource)
  })

  test('reactiveCompactOnPromptTooLong forwards options.querySource (manual /compact path)', async () => {
    // Manual /compact path goes through reactiveCompactOnPromptTooLong
    // directly, not via tryReactiveCompact. Verify the options.querySource
    // also threads through.
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()
    const cacheSafeParams = createCacheSafeParams(messages)

    const outcome = await reactive.reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      { trigger: 'manual', querySource: 'repl_main_thread' as never },
      deps,
    )

    expect(outcome.ok).toBe(true)
    expect(deps.runPostCompactCleanup).toHaveBeenCalledWith(
      'repl_main_thread',
    )
  })

  test('setLastSummarizedMessageId is skipped for subagent querySource', async () => {
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()

    await reactive.tryReactiveCompact(
      {
        hasAttempted: false,
        querySource: 'agent:test-agent' as never,
        aborted: false,
        messages,
        cacheSafeParams: createCacheSafeParams(messages),
      },
      deps,
    )

    expect(deps.setLastSummarizedMessageId).not.toHaveBeenCalled()
  })

  test('setLastSummarizedMessageId is called for main-thread querySource', async () => {
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()

    await reactive.tryReactiveCompact(
      {
        hasAttempted: false,
        querySource: 'repl_main_thread' as never,
        aborted: false,
        messages,
        cacheSafeParams: createCacheSafeParams(messages),
      },
      deps,
    )

    expect(deps.setLastSummarizedMessageId).toHaveBeenCalledWith(undefined)
  })

  test('reactiveCompactOnPromptTooLong defaults to undefined when querySource omitted', async () => {
    // Direct helper callers may omit querySource; undefined remains the
    // documented main-thread default for runPostCompactCleanup.
    process.env.CLAUDE_CODE_REACTIVE_COMPACT = '1'
    const messages = conversationWithOldImage()
    const deps = createDeps()
    const cacheSafeParams = createCacheSafeParams(messages)

    const outcome = await reactive.reactiveCompactOnPromptTooLong(
      messages,
      cacheSafeParams,
      { trigger: 'manual' }, // no querySource
      deps,
    )

    expect(outcome.ok).toBe(true)
    expect(deps.runPostCompactCleanup).toHaveBeenCalledWith(undefined)
  })
})

function createDeps(): ReactiveCompactDeps & {
  compactConversation: ReturnType<typeof mock>
  setLastSummarizedMessageId: ReturnType<typeof mock>
  runPostCompactCleanup: ReturnType<typeof mock>
  suppressCompactWarning: ReturnType<typeof mock>
} {
  return {
    compactConversation: mock(async () => compactResult) as never,
    stripImagesFromMessages: (messages: never[]) =>
      messages.map(message => stripMediaBlocks(message)) as never,
    setLastSummarizedMessageId: mock((_id: string | undefined) => {}) as never,
    runPostCompactCleanup: mock(() => {}) as never,
    suppressCompactWarning: mock(() => {}) as never,
  }
}

function createCacheSafeParams(messages: unknown[]) {
  return {
    systemPrompt: [] as never,
    userContext: {},
    systemContext: {},
    toolUseContext: createContext(),
    forkContextMessages: messages,
  }
}

function createContext() {
  return {
    abortController: new AbortController(),
    options: { mainLoopModel: 'test-model' },
  } as never
}

function conversationWithOldImage() {
  return [
    user('u1', [
      { type: 'text', text: 'old context' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
    ]),
    assistant('a1', 'assistant one'),
    user('u2', largeText('recent user one')),
    assistant('a2', largeText('recent assistant two')),
    user('u3', largeText('recent user three')),
    assistant('a3', largeText('recent assistant four')),
    user('u4', largeText('recent user five')),
    assistant('a4', largeText('recent assistant six')),
  ]
}

function largeText(prefix: string): string {
  return `${prefix} ${'x'.repeat(40_000)}`
}

function user(uuid: string, content: unknown) {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-05-14T00:00:00.000Z',
    message: { role: 'user', content },
  }
}

function assistant(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-05-14T00:00:00.000Z',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }
}

function assistantApiError(content: string, errorDetails = content) {
  return {
    ...assistant('err', content),
    isApiErrorMessage: true,
    apiError: 'invalid_request',
    errorDetails,
  }
}

function stripMediaBlocks(message: unknown): unknown {
  if (
    !message ||
    typeof message !== 'object' ||
    (message as { type?: unknown }).type !== 'user'
  ) {
    return message
  }
  const userMessage = message as {
    message: { content: unknown }
  }
  if (!Array.isArray(userMessage.message.content)) return message
  let changed = false
  const content = userMessage.message.content.map(block => {
    if (
      block &&
      typeof block === 'object' &&
      ((block as { type?: unknown }).type === 'image' ||
        (block as { type?: unknown }).type === 'document')
    ) {
      changed = true
      return { type: 'text', text: `[${(block as { type: string }).type}]` }
    }
    return block
  })
  if (!changed) return message
  return {
    ...(message as object),
    message: { ...userMessage.message, content },
  }
}
