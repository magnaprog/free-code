import { describe, expect, test } from 'bun:test'
import { bedrockConverseFetchAdapterTestHooks } from './bedrock-converse-fetch-adapter.js'

describe('bedrock converse fetch adapter translation', () => {
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
    expect(text).toContain('"usage":{"input_tokens":10,"output_tokens":20}')
  })

  test('translates ConverseStream service errors to Anthropic error events', async () => {
    async function* stream() {
      yield {
        validationException: {
          name: 'ValidationException',
          message: 'bad converse request',
        },
      }
    }

    const response =
      bedrockConverseFetchAdapterTestHooks.createAnthropicStreamFromBedrock(
        stream(),
        'amazon.nova-pro-v1:0',
      )

    const text = await response.text()
    expect(text).toContain('event: error')
    expect(text).toContain('validationException: bad converse request')
    expect(text).not.toContain('event: message_stop')
  })
})
