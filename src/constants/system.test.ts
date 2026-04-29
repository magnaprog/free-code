import { afterEach, describe, expect, test } from 'bun:test'
import {
  getAttributionHeader,
  isAttributionHeaderEnabled,
} from './system.js'

const originalAttribution = process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION
const originalMacro = (globalThis as any).MACRO

afterEach(() => {
  if (originalAttribution === undefined) {
    delete process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION
  } else {
    process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION = originalAttribution
  }

  if (originalMacro === undefined) {
    delete (globalThis as any).MACRO
  } else {
    ;(globalThis as any).MACRO = originalMacro
  }
})

describe('free-code attribution header policy', () => {
  test('disables Anthropic attribution by default', () => {
    delete process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION

    expect(isAttributionHeaderEnabled()).toBe(false)
    expect(getAttributionHeader('abc')).toBe('')
  })

  test('enables Anthropic attribution only by explicit free-code opt-in', () => {
    process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION = 'true'
    ;(globalThis as any).MACRO = { VERSION: 'test-version' }

    expect(isAttributionHeaderEnabled()).toBe(true)
    expect(getAttributionHeader('abc')).toContain('x-anthropic-billing-header')
  })
})
