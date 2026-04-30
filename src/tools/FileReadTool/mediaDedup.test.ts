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

function messageWithImage(uuid: string, sourceToolAssistantUUID?: string): Message {
  return {
    type: 'user',
    uuid,
    sourceToolAssistantUUID,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_test',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: 'abc',
              },
            },
          ],
        },
      ],
    },
  } as Message
}

function apiErrorMessage(): Message {
  return {
    type: 'assistant',
    uuid: 'api-error',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Request too large' }],
    },
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

  test('requires the source media to remain visible', () => {
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'assistant-1' },
        [messageWithImage('tool-result-1', 'assistant-1')],
      ),
    ).toBe(true)
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'media-message-1' },
        [messageWithImage('media-message-1')],
      ),
    ).toBe(true)
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'assistant-1' },
        [messageWithUuid('assistant-1')],
      ),
    ).toBe(false)
    expect(
      isMediaReadRecordVisible({ timestamp: 10, size: 20 }, [
        messageWithImage('tool-result-1', 'assistant-1'),
      ]),
    ).toBe(false)
  })

  test('does not reuse media reads after API media stripping would apply', () => {
    const messages = Array.from({ length: 101 }, (_, index) =>
      messageWithImage(`media-${index}`),
    )

    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'media-0' },
        messages,
      ),
    ).toBe(false)
  })

  test('does not reuse media reads after a later API error', () => {
    expect(
      isMediaReadRecordVisible(
        { timestamp: 10, size: 20, lastMessageUuid: 'media-1' },
        [messageWithImage('media-1'), apiErrorMessage()],
      ),
    ).toBe(false)
  })
})
