import { describe, expect, test } from 'bun:test'
import type { Message } from '../../types/message.js'
import {
  getMediaReadKey,
  getMediaReadKind,
  isMediaReadRecordVisible,
  isMediaReadUnchanged,
} from './FileReadTool.js'

function messageWithUuid(uuid: string): Message {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: 'message' },
  } as Message
}

describe('media read dedup helpers', () => {
  test('classifies media reads without using specific workflows', () => {
    expect(getMediaReadKind('png')).toBe('image')
    expect(getMediaReadKind('webp')).toBe('image')
    expect(getMediaReadKind('pdf')).toBe('pdf')
    expect(getMediaReadKind('pdf', '1-2')).toBe('pdf_pages')
    expect(getMediaReadKind('txt')).toBeUndefined()
  })

  test('includes page range in media dedup keys', () => {
    expect(getMediaReadKey('/tmp/a.pdf', 'pdf_pages', '1-2')).toBe(
      'pdf_pages:/tmp/a.pdf:1-2',
    )
    expect(getMediaReadKey('/tmp/a.png', 'image')).toBe('image:/tmp/a.png')
  })

  test('matches unchanged media by timestamp and size', () => {
    expect(
      isMediaReadUnchanged(
        { timestamp: 10.25, size: 20 },
        { timestamp: 10.25, size: 20 },
      ),
    ).toBe(true)
    expect(
      isMediaReadUnchanged(
        { timestamp: 10.25, size: 20 },
        { timestamp: 10.5, size: 20 },
      ),
    ).toBe(false)
    expect(
      isMediaReadUnchanged(undefined, { timestamp: 10, size: 20 }),
    ).toBe(false)
  })

  test('requires the source assistant message to remain visible', () => {
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'assistant-1' },
        [messageWithUuid('assistant-1')],
      ),
    ).toBe(true)
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'assistant-1' },
        [messageWithUuid('other')],
      ),
    ).toBe(false)
    expect(
      isMediaReadRecordVisible({ timestamp: 10, size: 20 }, [
        messageWithUuid('assistant-1'),
      ]),
    ).toBe(false)
  })
})
