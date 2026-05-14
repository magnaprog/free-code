import { describe, expect, test } from 'bun:test'

import { formatQueueCommand, parseQueueCommand } from './queueCommand.js'

describe('formatQueueCommand', () => {
  test('formats queue commands', () => {
    expect(formatQueueCommand('hello')).toBe('/queue hello')
    expect(formatQueueCommand('/clear')).toBe('/queue /clear')
    expect(formatQueueCommand('')).toBe('/queue')
  })
})

describe('parseQueueCommand', () => {
  test('parses queue command payloads', () => {
    expect(parseQueueCommand('/queue hello')).toBe('hello')
    expect(parseQueueCommand('/queue   hello')).toBe('hello')
    expect(parseQueueCommand('/queue /clear')).toBe('/clear')
    expect(parseQueueCommand('/queue [Image #1]')).toBe('[Image #1]')
    expect(parseQueueCommand('/queue')).toBe('')
    expect(parseQueueCommand('/queue   ')).toBe('')
    expect(parseQueueCommand(' /queue hello')).toBe('hello')
    expect(parseQueueCommand('/queue\nhello')).toBe('hello')
    expect(parseQueueCommand('/queue   \n   ')).toBe('   ')
  })

  test('rejects non-queue inputs', () => {
    expect(parseQueueCommand('/queue/clear')).toBeNull()
    expect(parseQueueCommand('/queueing hello')).toBeNull()
    expect(parseQueueCommand('hello /queue world')).toBeNull()
    expect(parseQueueCommand('/Queue hello')).toBeNull()
  })
})
