import { describe, expect, test } from 'bun:test'
import { INTERRUPTED_BY_USER_FOLLOWUP } from './InterruptedByUser.js'

describe('InterruptedByUser', () => {
  test('uses provider-neutral follow-up copy', () => {
    expect(INTERRUPTED_BY_USER_FOLLOWUP).toBe('· What should we do instead?')
    expect(INTERRUPTED_BY_USER_FOLLOWUP).not.toContain('Claude')
  })
})
