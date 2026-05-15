import { afterEach, describe, expect, test } from 'bun:test'
import {
  formatCompactionConfigSummary,
  getCompactionConfig,
  getCompactionThresholds,
} from './compactionConfig.js'

const OLD_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...OLD_ENV }
})

describe('compaction config', () => {
  test('honors existing disable env vars', () => {
    process.env.DISABLE_COMPACT = '1'

    const config = getCompactionConfig('test-model')

    expect(config.enabled).toBe(false)
    expect(config.auto.enabled).toBe(false)
  })

  test('keeps existing threshold env overrides', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '50'
    process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE = '75000'

    const config = getCompactionConfig('test-model')
    const thresholds = getCompactionThresholds('test-model')

    expect(config.auto.thresholdPct).toBe(0.5)
    expect(thresholds.compact).toBe(40000)
    expect(thresholds.block).toBe(75000)
    expect(formatCompactionConfigSummary(config)).toContain('auto:50%')
  })

  test('keeps structured summaries off by default and env gated', () => {
    expect(getCompactionConfig('test-model').summary.structured).toBe(false)

    process.env.CLAUDE_CODE_STRUCTURED_COMPACT = '1'

    const config = getCompactionConfig('test-model')
    expect(config.summary.structured).toBe(true)
    expect(formatCompactionConfigSummary(config)).toContain(
      'structured-summary:on',
    )
  })
})
