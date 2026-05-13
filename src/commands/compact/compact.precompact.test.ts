import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { setIsInteractive } from '../../bootstrap/state.js'

type HookConfig = Record<string, unknown>

let hooksConfig: HookConfig = {}
const originalApiKey = process.env.ANTHROPIC_API_KEY
const originalMacro = (globalThis as { MACRO?: unknown }).MACRO

const trySessionMemoryCompaction = mock(async () => null)
const compactConversation = mock(async () => ({
  boundaryMarker: {} as never,
  summaryMessages: [],
  attachments: [],
  hookResults: [],
}))
const microcompactMessages = mock(async (messages: unknown[]) => ({ messages }))

class PreCompactBlockedError extends Error {
  constructor(reason?: string) {
    super(reason)
  }
}

mock.module('../../utils/hooks/hooksConfigSnapshot.js', () => ({
  captureHooksConfigSnapshot: () => {},
  getHooksConfigFromSnapshot: () => hooksConfig,
  resetHooksConfigSnapshot: () => {},
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
  updateHooksConfigSnapshot: () => {},
}))

mock.module('../../services/compact/sessionMemoryCompact.js', () => ({
  trySessionMemoryCompaction,
}))

mock.module('../../services/compact/microCompact.js', () => ({
  TIME_BASED_MC_CLEARED_MESSAGE: '[Old tool result content cleared]',
  consumePendingCacheEdits: () => null,
  evaluateTimeBasedTrigger: () => false,
  estimateMessageTokens: () => 0,
  getPinnedCacheEdits: () => [],
  markToolsSentToAPIState: () => {},
  microcompactMessages,
  pinCacheEdits: () => {},
  resetMicrocompactState: () => {},
}))

mock.module('../../services/compact/compact.js', () => ({
  compactConversation,
  buildPostCompactMessages: () => [],
  ERROR_MESSAGE_COMPACT_OUTPUT_LIMIT: 'compact output limit',
  ERROR_MESSAGE_INCOMPLETE_RESPONSE: 'incomplete',
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES: 'not enough',
  ERROR_MESSAGE_USER_ABORT: 'aborted',
  isPreCompactBlockedError: (error: unknown) =>
    error instanceof PreCompactBlockedError,
  mergeHookInstructions: (user?: string, hook?: string) =>
    user && hook ? `${user}\n\n${hook}` : user || hook,
  throwIfPreCompactBlocked: (result: {
    blocked?: boolean
    blockedReason?: string
  }) => {
    if (result.blocked) throw new PreCompactBlockedError(result.blockedReason)
  },
}))

mock.module('../../services/compact/compactWarningState.js', () => ({
  suppressCompactWarning: () => {},
}))

mock.module('../../services/compact/postCompactCleanup.js', () => ({
  runPostCompactCleanup: () => {},
}))

mock.module('../../services/SessionMemory/sessionMemoryUtils.js', () => ({
  setLastSummarizedMessageId: () => {},
}))

mock.module('../../context.js', () => ({
  getSystemContext: async () => ({}),
  getUserContext: Object.assign(async () => ({}), { cache: { clear: () => {} } }),
}))

const { call } = await import('./compact.js')

afterAll(() => {
  mock.restore()
})

const message = {
  type: 'user',
  uuid: 'msg-1',
  timestamp: '2026-05-13T00:00:00.000Z',
  message: { role: 'user', content: 'hello' },
}

function createContext() {
  return {
    abortController: new AbortController(),
    messages: [message],
    agentId: 'agent-1',
    options: {
      verbose: true,
      querySource: 'compact',
      tools: [],
      mainLoopModel: 'claude-test',
      mcpClients: [],
    },
    getAppState: () => ({
      toolPermissionContext: {
        additionalWorkingDirectories: new Map(),
      },
    }),
  } as never
}

describe('/compact PreCompact fast path', () => {
  beforeEach(() => {
    hooksConfig = {}
    process.env.ANTHROPIC_API_KEY = 'test-key'
    ;(globalThis as { MACRO?: unknown }).MACRO = {
      BUILD_TIME: '',
      FEEDBACK_CHANNEL: '',
      ISSUES_EXPLAINER: '',
      VERSION: 'test-version',
      VERSION_CHANGELOG: '',
    }
    setIsInteractive(false)
    trySessionMemoryCompaction.mockClear()
    compactConversation.mockClear()
    microcompactMessages.mockClear()
  })

  afterEach(() => {
    setIsInteractive(true)
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
    if (originalMacro === undefined) {
      delete (globalThis as { MACRO?: unknown }).MACRO
    } else {
      ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
    }
  })

  test('blocks before session-memory compaction', async () => {
    hooksConfig = {
      PreCompact: [
        {
          matcher: 'manual',
          hooks: [
            { type: 'command', command: 'cat >/dev/null; printf stop; exit 2' },
          ],
        },
      ],
    }

    await expect(call('', createContext())).rejects.toBeInstanceOf(
      PreCompactBlockedError,
    )

    expect(trySessionMemoryCompaction).not.toHaveBeenCalled()
    expect(compactConversation).not.toHaveBeenCalled()
  })

  test('skips session-memory compaction when hooks add instructions', async () => {
    hooksConfig = {
      PreCompact: [
        {
          matcher: 'manual',
          hooks: [
            {
              type: 'command',
              command: 'cat >/dev/null; printf "preserve this detail"',
            },
          ],
        },
      ],
    }

    await call('', createContext())

    expect(trySessionMemoryCompaction).not.toHaveBeenCalled()
    expect(compactConversation).toHaveBeenCalledTimes(1)
    const compactArgs = compactConversation.mock.calls[0] as unknown[]
    const preCompactHookResult = compactArgs.at(-1)
    expect(preCompactHookResult).toMatchObject({
      newCustomInstructions: 'preserve this detail',
    })
  })
})
