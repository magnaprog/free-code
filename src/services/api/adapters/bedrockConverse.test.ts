import { describe, expect, test } from 'bun:test'
import {
  bedrockConverseFetchAdapterTestHooks,
  createBedrockConverseFetch,
} from './bedrockConverse.js'

function parseSseData(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

describe('bedrock converse fetch adapter translation', () => {
  test('uses upstream fetch for pass-through routes', async () => {
    const dispatcher = { name: 'bedrock-dispatcher' }
    let observedInit: (RequestInit & { dispatcher?: unknown }) | undefined
    const upstreamFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedInit = init as RequestInit & { dispatcher?: unknown }
      return new Response('ok')
    }) as typeof fetch
    const fetch = createBedrockConverseFetch(undefined, upstreamFetch)

    const response = await fetch('https://example.test/other', {
      dispatcher,
    } as RequestInit & { dispatcher: unknown })

    expect(await response.text()).toBe('ok')
    expect(observedInit?.dispatcher).toBe(dispatcher)
  })

  test('maps Anthropic request controls to Converse fields', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'amazon.nova-pro-v1:0',
        max_tokens: 1234,
        temperature: 0.2,
        top_p: 0.8,
        stop_sequences: ['</done>'],
        system: [{ type: 'text', text: 'Be precise.' }],
        tool_choice: { type: 'tool', name: 'Read' },
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            input_schema: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        ],
        messages: [
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'Read',
                input: { file_path: 'a.ts' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: 'file contents',
              },
            ],
          },
        ],
      })

    expect(request.modelId).toBe('amazon.nova-pro-v1:0')
    expect(request.inferenceConfig).toEqual({
      maxTokens: 1234,
      temperature: 0.2,
      topP: 0.8,
      stopSequences: ['</done>'],
    })
    expect(request.system).toEqual([{ text: 'Be precise.' }])
    expect(request.toolConfig?.toolChoice).toEqual({ tool: { name: 'Read' } })
    expect(request.toolConfig?.tools).toEqual([
      {
        toolSpec: {
          name: 'Read',
          description: 'Read a file',
          inputSchema: {
            json: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        },
      },
    ])
    expect(request.messages).toEqual([
      { role: 'user', content: [{ text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          {
            toolUse: {
              toolUseId: 'toolu_123',
              name: 'Read',
              input: { file_path: 'a.ts' },
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: 'toolu_123',
              content: [{ text: 'file contents' }],
            },
          },
        ],
      },
    ])
  })

  test('generates unique fallback toolUse IDs within one request', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'amazon.nova-pro-v1:0',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: 'a.ts' },
              },
              {
                type: 'tool_use',
                name: 'Read',
                input: { file_path: 'b.ts' },
              },
            ],
          },
        ],
      })

    const content = request.messages?.[0]?.content || []
    expect(content).toEqual([
      {
        toolUse: {
          toolUseId: 'toolu_fallback_1',
          name: 'Read',
          input: { file_path: 'a.ts' },
        },
      },
      {
        toolUse: {
          toolUseId: 'toolu_fallback_2',
          name: 'Read',
          input: { file_path: 'b.ts' },
        },
      },
    ])
  })

  test('preserves tool result images for Bedrock models that support them', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'amazon.nova-pro-v1:0',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: [
                  { type: 'text', text: 'screenshot' },
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'aGVsbG8=',
                    },
                  },
                ],
              },
            ],
          },
        ],
      })

    expect(request.messages?.[0]?.content).toEqual([
      {
        toolResult: {
          toolUseId: 'toolu_123',
          content: [
            { text: 'screenshot' },
            {
              image: {
                format: 'png',
                source: { bytes: Buffer.from('aGVsbG8=', 'base64') },
              },
            },
          ],
        },
      },
    ])
  })

  test('degrades tool result images for Bedrock models without image tool results', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'mistral.mistral-large-2407-v1:0',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: 'image/png',
                      data: 'aGVsbG8=',
                    },
                  },
                ],
              },
            ],
          },
        ],
      })

    expect(request.messages?.[0]?.content).toEqual([
      {
        toolResult: {
          toolUseId: 'toolu_123',
          content: [{ text: '[Image data attached]' }],
        },
      },
    ])
  })

  test('translates non-stream Converse output to Anthropic message shape', async () => {
    const response =
      bedrockConverseFetchAdapterTestHooks.translateConverseOutputToAnthropic(
        {
          output: {
            message: {
              role: 'assistant',
              content: [
                { text: 'done' },
                {
                  toolUse: {
                    toolUseId: 'toolu_123',
                    name: 'Edit',
                    input: { file_path: 'a.ts' },
                  },
                },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          metrics: { latencyMs: 1 },
          $metadata: {},
        },
        'amazon.nova-pro-v1:0',
      )

    const body = await response.json()
    expect(body).toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'done' },
        {
          type: 'tool_use',
          id: 'toolu_123',
          name: 'Edit',
          input: { file_path: 'a.ts' },
        },
      ],
      model: 'amazon.nova-pro-v1:0',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
    expect(body.id).toStartWith('msg_bedrock_')
  })

  test('generates unique fallback tool_use IDs from non-stream Converse output', async () => {
    const response =
      bedrockConverseFetchAdapterTestHooks.translateConverseOutputToAnthropic(
        {
          output: {
            message: {
              role: 'assistant',
              content: [
                { toolUse: { name: 'Read', input: { file_path: 'a.ts' } } },
                { toolUse: { name: 'Read', input: { file_path: 'b.ts' } } },
              ],
            },
          },
          stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          metrics: { latencyMs: 1 },
          $metadata: {},
        },
        'amazon.nova-pro-v1:0',
      )

    const body = await response.json()
    expect(body.content.map((block: { id?: string }) => block.id)).toEqual([
      'toolu_fallback_1',
      'toolu_fallback_2',
    ])
  })

  test('omits Bedrock tools when Anthropic tool_choice is none', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'amazon.nova-pro-v1:0',
        tool_choice: { type: 'none' },
        tools: [
          {
            name: 'Read',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      })

    expect(request.toolConfig).toBeUndefined()
  })

  test('omits unsupported forced toolChoice for non-Nova Bedrock models', () => {
    const request =
      bedrockConverseFetchAdapterTestHooks.translateToConverseRequest({
        model: 'mistral.mistral-large-2407-v1:0',
        tool_choice: { type: 'tool', name: 'Read' },
        tools: [
          {
            name: 'Read',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        messages: [{ role: 'user', content: 'hello' }],
      })

    expect(request.toolConfig?.tools).toHaveLength(1)
    expect(request.toolConfig?.toolChoice).toBeUndefined()
  })

  test('translates ConverseStream text and tool deltas to Anthropic SSE', async () => {
    async function* stream() {
      yield { messageStart: { role: 'assistant' } }
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'hi' } } }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: 'toolu_123', name: 'Read' } },
        },
      }
      yield {
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"file_path":"a.ts"}' } },
        },
      }
      yield { contentBlockStop: { contentBlockIndex: 1 } }
      yield { messageStop: { stopReason: 'tool_use' } }
      yield {
        metadata: {
          usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
          metrics: { latencyMs: 1 },
        },
      }
    }

    const response =
      bedrockConverseFetchAdapterTestHooks.createAnthropicStreamFromBedrock(
        stream(),
        'amazon.nova-pro-v1:0',
      )

    const text = await response.text()
    expect(text).toContain('event: message_start')
    expect(text).toContain('"type":"text_delta","text":"hi"')
    expect(text).toContain('"type":"tool_use","id":"toolu_123","name":"Read"')
    expect(text).toContain(
      '"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"a.ts\\"}"',
    )
    expect(text).toContain('"stop_reason":"tool_use"')
    const messageDelta = parseSseData(text).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 20,
    })
  })

  test('generates unique fallback tool_use IDs from ConverseStream output', async () => {
    async function* stream() {
      yield {
        contentBlockStart: {
          contentBlockIndex: 0,
          start: { toolUse: { name: 'Read' } },
        },
      }
      yield { contentBlockStop: { contentBlockIndex: 0 } }
      yield {
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { name: 'Read' } },
        },
      }
      yield { contentBlockStop: { contentBlockIndex: 1 } }
      yield { messageStop: { stopReason: 'tool_use' } }
    }

    const response =
      bedrockConverseFetchAdapterTestHooks.createAnthropicStreamFromBedrock(
        stream(),
        'amazon.nova-pro-v1:0',
      )

    const text = await response.text()
    expect(text).toContain('"id":"toolu_fallback_1"')
    expect(text).toContain('"id":"toolu_fallback_2"')
  })

  test('removes init abort listener after non-stream Bedrock request', async () => {
    const controller = new AbortController()
    let addCount = 0
    let removeCount = 0
    const originalAddEventListener = controller.signal.addEventListener.bind(
      controller.signal,
    )
    const originalRemoveEventListener =
      controller.signal.removeEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args) => {
      addCount++
      return originalAddEventListener(...args)
    }) as typeof controller.signal.addEventListener
    controller.signal.removeEventListener = ((...args) => {
      removeCount++
      return originalRemoveEventListener(...args)
    }) as typeof controller.signal.removeEventListener

    const fetch = createBedrockConverseFetch(async () => ({
      send: async () => ({
        output: { message: { role: 'assistant', content: [] } },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
    }))

    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      body: JSON.stringify({
        model: 'amazon.nova-pro-v1:0',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(addCount).toBe(1)
    expect(removeCount).toBe(1)
  })

  test('downstream body cancellation aborts Bedrock stream request', async () => {
    let observedSignal: AbortSignal | undefined
    const fetch = createBedrockConverseFetch(async () => ({
      send: async (_command, options) => {
        observedSignal = options?.abortSignal
        return {
          stream: {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<IteratorResult<unknown>>(() => {}),
              return: () => Promise.resolve({ done: true, value: undefined }),
            }),
          },
        }
      },
    }))

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'amazon.nova-pro-v1:0',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(observedSignal?.aborted).toBe(false)
    await response.body!.cancel('client-stop')
    expect(observedSignal?.aborted).toBe(true)
  })

  test('downstream body cancellation returns upstream iterator', async () => {
    let returnReason: unknown
    let resolveNext: ((value: IteratorResult<unknown>) => void) | undefined
    const iterator = {
      next: () =>
        new Promise<IteratorResult<unknown>>(resolve => {
          resolveNext = resolve
        }),
      return: (reason?: unknown) => {
        returnReason = reason
        resolveNext?.({ done: true, value: undefined })
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const response =
      bedrockConverseFetchAdapterTestHooks.createAnthropicStreamFromBedrock(
        stream as never,
        'amazon.nova-pro-v1:0',
      )

    await response.body!.cancel('client-stop')
    expect(returnReason).toBe('client-stop')
  })

  test('translates ConverseStream service errors to Anthropic error events', async () => {
    let returned = false
    const iterator = {
      next: () =>
        Promise.resolve({
          done: false,
          value: {
            validationException: {
              name: 'ValidationException',
              message: 'bad converse request',
            },
          },
        }),
      return: () => {
        returned = true
        return Promise.resolve({ done: true, value: undefined })
      },
    }
    const stream = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const response =
      bedrockConverseFetchAdapterTestHooks.createAnthropicStreamFromBedrock(
        stream as never,
        'amazon.nova-pro-v1:0',
      )

    const text = await response.text()
    expect(text).toContain('event: error')
    expect(text).toContain('validationException: bad converse request')
    expect(text).not.toContain('event: message_stop')
    expect(returned).toBe(true)
  })
})
