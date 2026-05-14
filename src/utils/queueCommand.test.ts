import { describe, expect, test } from 'bun:test'

import { parseQueueCommand } from './queueCommand.js'

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
