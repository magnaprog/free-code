import { describe, expect, test } from 'bun:test'
import { extractFirstMessageText } from './fingerprint.js'
import { createUserMessage } from './messages.js'

describe('fingerprint message extraction', () => {
  test('uses the first non-meta user message', () => {
    const messages = [
      createUserMessage({ content: 'synthetic context', isMeta: true }),
      createUserMessage({ content: 'actual user prompt' }),
    ]

    expect(extractFirstMessageText(messages)).toBe('actual user prompt')
  })

  test('returns empty string when only meta user messages exist', () => {
    const messages = [createUserMessage({ content: 'synthetic context', isMeta: true })]

    expect(extractFirstMessageText(messages)).toBe('')
  })
})
