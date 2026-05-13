import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'

const originalSmCompact = process.env.ENABLE_CLAUDE_CODE_SM_COMPACT

mock.module('../analytics/growthbook.js', () => ({
  checkGate_CACHED_OR_BLOCKING: async () => false,
  checkSecurityRestrictionGate: async () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
  getDynamicConfig_BLOCKS_ON_INIT: async () => ({
    minTokens: 1,
    minTextBlockMessages: 1,
    maxTokens: 40_000,
  }),
  getDynamicConfig_CACHED_MAY_BE_STALE: <T>(_key: string, defaultValue: T) =>
    defaultValue,
  getFeatureValue_CACHED_MAY_BE_STALE: <T>(_key: string, defaultValue: T) =>
    defaultValue,
  getFeatureValue_CACHED_WITH_REFRESH: <T>(_key: string, defaultValue: T) =>
    defaultValue,
  getFeatureValue_DEPRECATED: async <T>(_key: string, defaultValue: T) =>
    defaultValue,
  onGrowthBookRefresh: () => () => {},
  refreshGrowthBookAfterAuthChange: () => {},
}))

mock.module('../analytics/index.js', () => ({
  logEvent: () => {},
}))

mock.module('../SessionMemory/sessionMemoryUtils.js', () => ({
  getLastSummarizedMessageId: () => undefined,
  getSessionMemoryContent: async () => 'Remember the hook display message.',
  setLastSummarizedMessageId: () => {},
  waitForSessionMemoryExtraction: async () => {},
}))

mock.module('../../utils/sessionStart.js', () => ({
  processSessionStartHooks: async () => [],
}))


const { resetSessionMemoryCompactConfig, trySessionMemoryCompaction } =
  await import('./sessionMemoryCompact.js')

afterAll(() => {
  mock.restore()
})

const message = {
  type: 'user',
  uuid: 'msg-1',
  timestamp: '2026-05-13T00:00:00.000Z',
  message: { role: 'user', content: 'hello' },
} as Message

describe('session-memory PreCompact results', () => {
  beforeEach(() => {
    process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = 'true'
    resetSessionMemoryCompactConfig()
  })

  afterEach(() => {
    resetSessionMemoryCompactConfig()
    if (originalSmCompact === undefined) {
      delete process.env.ENABLE_CLAUDE_CODE_SM_COMPACT
    } else {
      process.env.ENABLE_CLAUDE_CODE_SM_COMPACT = originalSmCompact
    }
  })

  test('preserves PreCompact display message in session-memory result', async () => {
    const result = await trySessionMemoryCompaction(
      [message],
      'agent-1' as AgentId,
      undefined,
      { userDisplayMessage: 'PreCompact completed successfully' },
    )

    expect(result).not.toBeNull()
    expect(result?.userDisplayMessage).toBe('PreCompact completed successfully')
  })
})
