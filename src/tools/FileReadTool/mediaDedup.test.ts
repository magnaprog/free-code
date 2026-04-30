import { describe, expect, test } from 'bun:test'
import {
  getMediaReadKey,
  getMediaReadKind,
  isMediaReadUnchanged,
} from './FileReadTool.js'

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
        { timestamp: 10, size: 20 },
        { timestamp: 10, size: 20 },
      ),
    ).toBe(true)
    expect(
      isMediaReadUnchanged(
        { timestamp: 10, size: 20 },
        { timestamp: 11, size: 20 },
      ),
    ).toBe(false)
    expect(
      isMediaReadUnchanged(undefined, { timestamp: 10, size: 20 }),
    ).toBe(false)
  })
})
