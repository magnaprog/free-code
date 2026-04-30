import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import {
  FileReadTool,
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

function createToolUseContext(messages: Message[] = []): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    abortController: new AbortController(),
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'claude-sonnet-4-6',
      tools: [FileReadTool],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState: () => appState,
    setAppState: () => {},
    messages,
    readFileState: createFileStateCacheWithSizeLimit(10),
    mediaReadState: new Map(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as ToolUseContext
}

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJdz9wAAAABJRU5ErkJggg==',
  'base64',
)

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

  test('dedups unchanged image reads only when prior media tool result is visible', async () => {
    const previousSimple = process.env.CLAUDE_CODE_SIMPLE
    process.env.CLAUDE_CODE_SIMPLE = '1'
    const dir = await mkdtemp(join(tmpdir(), 'free-code-media-dedup-'))
    const imagePath = join(dir, 'tiny.png')

    try {
      await writeFile(imagePath, TINY_PNG)
      const assistantMessage = createAssistantMessage({ content: [] })
      const context = createToolUseContext()
      const first = await FileReadTool.call(
        { file_path: imagePath },
        context,
        undefined,
        assistantMessage,
      )

      expect(first.data.type).toBe('image')
      const toolResultBlock = FileReadTool.mapToolResultToToolResultBlockParam(
        first.data,
        'toolu_image',
      )
      context.messages = [
        createUserMessage({
          content: [toolResultBlock],
          sourceToolAssistantUUID: assistantMessage.uuid,
          toolUseResult: first.data,
        }),
      ]

      const repeated = await FileReadTool.call(
        { file_path: imagePath },
        context,
        undefined,
        assistantMessage,
      )
      expect(repeated.data.type).toBe('file_unchanged')

      const hiddenContext = createToolUseContext()
      hiddenContext.mediaReadState = context.mediaReadState
      const hidden = await FileReadTool.call(
        { file_path: imagePath },
        hiddenContext,
        undefined,
        assistantMessage,
      )
      expect(hidden.data.type).toBe('image')
    } finally {
      if (previousSimple === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = previousSimple
      }
      await rm(dir, { recursive: true, force: true })
    }
  })
})
