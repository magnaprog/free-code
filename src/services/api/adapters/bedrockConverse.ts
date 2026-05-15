import type {
  ContentBlock,
  ConverseCommandInput,
  ConverseCommandOutput,
  ConverseStreamCommandInput,
  ConverseStreamCommandOutput,
  ImageBlock,
  ConverseStreamOutput,
  Message,
  Tool,
  ToolChoice,
  ToolResultContentBlock,
} from '@aws-sdk/client-bedrock-runtime'
import { createBedrockRuntimeClient } from '../../../utils/model/bedrock.js'

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: {
    type?: string
    media_type?: string
    data?: string
  }
  is_error?: boolean
  [key: string]: unknown
}

interface AnthropicMessage {
  role: string
  content: string | AnthropicContentBlock[]
}

interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

type BedrockRuntimeClientLike = {
  send(
    command: { input: ConverseCommandInput },
  ): Promise<ConverseCommandOutput>
  send(
    command: { input: ConverseStreamCommandInput },
  ): Promise<ConverseStreamCommandOutput>
}

type BedrockRuntimeClientFactory = () => Promise<BedrockRuntimeClientLike>

// Route classification shared with other adapters.
import {
  classifyAnthropicMessagesUrl,
  countTokensUnsupportedResponse,
} from '../anthropicMessagesPath.js'

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function coerceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error) {
    return error
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.originalMessage === 'string') {
      return record.originalMessage
    }
    if (typeof record.message === 'string') {
      return record.message
    }
  }
  return fallback
}

function getBedrockStreamError(event: ConverseStreamOutput): Error | null {
  const record = event as Record<string, unknown>
  const errorKeys = [
    'internalServerException',
    'modelStreamErrorException',
    'validationException',
    'throttlingException',
    'serviceUnavailableException',
  ]

  for (const key of errorKeys) {
    const error = record[key]
    if (error) {
      return new Error(
        `${key}: ${getErrorMessage(error, 'Bedrock ConverseStream error')}`,
      )
    }
  }

  if (Array.isArray(record.$unknown) && typeof record.$unknown[0] === 'string') {
    return new Error(`Unknown Bedrock ConverseStream event: ${record.$unknown[0]}`)
  }

  return null
}

function mediaTypeToBedrockImageFormat(mediaType: string | undefined):
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | undefined {
  switch (mediaType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    default:
      return undefined
  }
}

function createFallbackToolUseIdFactory(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `toolu_fallback_${counter}`
  }
}

function modelSupportsBedrockToolResultImages(modelId: string): boolean {
  const model = modelId.toLowerCase()
  return model.includes('amazon.nova') || model.includes('anthropic.claude')
}

function translateImageBlock(block: AnthropicContentBlock): ImageBlock | null {
  if (
    block.type !== 'image' ||
    block.source?.type !== 'base64' ||
    typeof block.source.data !== 'string'
  ) {
    return null
  }

  const format = mediaTypeToBedrockImageFormat(block.source.media_type)
  if (!format) {
    return null
  }

  return {
    format,
    source: {
      bytes: Buffer.from(block.source.data, 'base64'),
    },
  }
}

function translateSystem(system: unknown): Array<{ text: string }> | undefined {
  if (typeof system === 'string' && system.length > 0) {
    return [{ text: system }]
  }
  if (!Array.isArray(system)) {
    return undefined
  }

  const blocks = system
    .filter(
      block =>
        block &&
        typeof block === 'object' &&
        (block as AnthropicContentBlock).type === 'text' &&
        typeof (block as AnthropicContentBlock).text === 'string',
    )
    .map(block => ({ text: (block as AnthropicContentBlock).text! }))
  return blocks.length > 0 ? blocks : undefined
}

function translateToolResultContent(
  content: string | AnthropicContentBlock[] | undefined,
  modelId: string,
): ToolResultContentBlock[] {
  if (typeof content === 'string') {
    return [{ text: content }]
  }

  if (!Array.isArray(content)) {
    return [{ text: '' }]
  }

  const result: ToolResultContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      result.push({ text: block.text })
    } else if (
      block.type === 'json' &&
      block.json !== undefined &&
      block.json !== null
    ) {
      result.push({ json: block.json })
    } else if (block.type === 'image') {
      const image = translateImageBlock(block)
      if (image && modelSupportsBedrockToolResultImages(modelId)) {
        result.push({ image })
      } else {
        result.push({ text: '[Image data attached]' })
      }
    } else {
      result.push({ text: JSON.stringify(block) })
    }
  }

  return result.length > 0 ? result : [{ text: '' }]
}

function translateContentBlock(
  block: AnthropicContentBlock,
  modelId: string,
  createFallbackToolUseId: () => string,
): ContentBlock | null {
  if (block.type === 'text' && typeof block.text === 'string') {
    return { text: block.text }
  }

  if (block.type === 'tool_use') {
    return {
      toolUse: {
        toolUseId: block.id || createFallbackToolUseId(),
        name: block.name || '',
        input: coerceObject(block.input),
      },
    }
  }

  if (block.type === 'tool_result') {
    return {
      toolResult: {
        toolUseId: block.tool_use_id || '',
        content: translateToolResultContent(block.content, modelId),
        ...(block.is_error === true && { status: 'error' as const }),
      },
    }
  }

  const image = translateImageBlock(block)
  if (image) {
    return { image }
  }

  return null
}

function translateMessages(messages: AnthropicMessage[], modelId: string): Message[] {
  const translated: Message[] = []
  const createFallbackToolUseId = createFallbackToolUseIdFactory()

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }

    if (typeof message.content === 'string') {
      translated.push({
        role: message.role,
        content: [{ text: message.content }],
      })
      continue
    }

    if (!Array.isArray(message.content)) {
      continue
    }

    const content = message.content
      .map(block => translateContentBlock(block, modelId, createFallbackToolUseId))
      .filter((block): block is ContentBlock => block !== null)
    if (content.length > 0) {
      translated.push({ role: message.role, content })
    }
  }

  return translated
}

function translateTools(tools: AnthropicTool[]): Tool[] | undefined {
  if (tools.length === 0) {
    return undefined
  }

  return tools.map(tool => ({
    toolSpec: {
      name: tool.name,
      description: tool.description || '',
      inputSchema: {
        json: tool.input_schema || { type: 'object', properties: {} },
      },
    },
  }))
}

function modelSupportsBedrockToolChoice(modelId: string): boolean {
  const model = modelId.toLowerCase()
  return model.includes('amazon.nova') || model.includes('anthropic.claude')
}

function translateToolChoice(
  toolChoice: unknown,
  modelId: string,
): ToolChoice | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return undefined
  }

  const choice = toolChoice as { type?: string; name?: string }
  switch (choice.type) {
    case 'auto':
      return modelSupportsBedrockToolChoice(modelId) ? { auto: {} } : undefined
    case 'any':
      return modelSupportsBedrockToolChoice(modelId) ? { any: {} } : undefined
    case 'tool':
      return choice.name && modelSupportsBedrockToolChoice(modelId)
        ? { tool: { name: choice.name } }
        : undefined
    case 'none':
    default:
      return undefined
  }
}

export function translateToConverseRequest(
  anthropicBody: Record<string, unknown>,
): ConverseCommandInput & ConverseStreamCommandInput {
  const modelId = String(anthropicBody.model || '')
  const messages = translateMessages(
    Array.isArray(anthropicBody.messages)
      ? (anthropicBody.messages as AnthropicMessage[])
      : [],
    modelId,
  )
  const requestedNoTools =
    typeof anthropicBody.tool_choice === 'object' &&
    anthropicBody.tool_choice !== null &&
    (anthropicBody.tool_choice as { type?: string }).type === 'none'
  const tools = requestedNoTools
    ? undefined
    : translateTools(
        Array.isArray(anthropicBody.tools)
          ? (anthropicBody.tools as AnthropicTool[])
          : [],
      )
  const toolChoice = translateToolChoice(anthropicBody.tool_choice, modelId)
  const system = translateSystem(anthropicBody.system)
  const inferenceConfig: ConverseCommandInput['inferenceConfig'] = {}

  if (typeof anthropicBody.max_tokens === 'number') {
    inferenceConfig.maxTokens = anthropicBody.max_tokens
  }
  if (typeof anthropicBody.temperature === 'number') {
    inferenceConfig.temperature = anthropicBody.temperature
  }
  if (typeof anthropicBody.top_p === 'number') {
    inferenceConfig.topP = anthropicBody.top_p
  }
  if (Array.isArray(anthropicBody.stop_sequences)) {
    inferenceConfig.stopSequences = anthropicBody.stop_sequences.filter(
      (sequence): sequence is string => typeof sequence === 'string',
    )
  }

  return {
    modelId,
    ...(messages.length > 0 && { messages }),
    ...(system && { system }),
    ...(Object.keys(inferenceConfig).length > 0 && { inferenceConfig }),
    ...(tools && {
      toolConfig: {
        tools,
        ...(toolChoice && { toolChoice }),
      },
    }),
  }
}

function translateStopReason(
  stopReason: string | undefined,
  sawToolUse = false,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
  if (sawToolUse || stopReason === 'tool_use') {
    return 'tool_use'
  }
  if (stopReason === 'max_tokens') {
    return 'max_tokens'
  }
  if (stopReason === 'stop_sequence') {
    return 'stop_sequence'
  }
  return 'end_turn'
}

function translateConverseOutputToAnthropic(
  response: ConverseCommandOutput,
  model: string,
): Response {
  const content: Array<Record<string, unknown>> = []
  const blocks = response.output?.message?.content || []
  let sawToolUse = false
  const createFallbackToolUseId = createFallbackToolUseIdFactory()

  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if ('toolUse' in block && block.toolUse) {
      sawToolUse = true
      content.push({
        type: 'tool_use',
        id: block.toolUse.toolUseId || createFallbackToolUseId(),
        name: block.toolUse.name || '',
        input: coerceObject(block.toolUse.input),
      })
    }
  }

  const message = {
    id: `msg_bedrock_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: translateStopReason(response.stopReason, sawToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.inputTokens ?? 0,
      output_tokens: response.usage?.outputTokens ?? 0,
    },
  }

  return new Response(JSON.stringify(message), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': message.id,
    },
  })
}

function createAnthropicStreamFromBedrock(
  stream: AsyncIterable<ConverseStreamOutput> | undefined,
  model: string,
): Response {
  const messageId = `msg_bedrock_${Date.now()}`
  const encoder = new TextEncoder()

  const readable = new ReadableStream({
    async start(controller) {
      let outputTokens = 0
      let inputTokens = 0
      let stopReason: string | undefined
      let sawToolUse = false
      const openBlocks = new Set<number>()
      const createFallbackToolUseId = createFallbackToolUseIdFactory()

      const emit = (event: string, payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(payload))))
      }

      emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })

      try {
        if (!stream) {
          throw new Error('Bedrock ConverseStream returned no stream')
        }

        for await (const event of stream) {
          const streamError = getBedrockStreamError(event)
          if (streamError) {
            throw streamError
          }

          if (event.messageStart) {
            continue
          }

          if (event.contentBlockStart) {
            const index = event.contentBlockStart.contentBlockIndex ?? 0
            const toolUse = event.contentBlockStart.start?.toolUse
            if (toolUse) {
              sawToolUse = true
              openBlocks.add(index)
              emit('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: {
                  type: 'tool_use',
                  id: toolUse.toolUseId || createFallbackToolUseId(),
                  name: toolUse.name || '',
                  input: {},
                },
              })
            }
            continue
          }

          if (event.contentBlockDelta) {
            const index = event.contentBlockDelta.contentBlockIndex ?? 0
            const delta = event.contentBlockDelta.delta
            if (typeof delta?.text === 'string') {
              if (!openBlocks.has(index)) {
                openBlocks.add(index)
                emit('content_block_start', {
                  type: 'content_block_start',
                  index,
                  content_block: { type: 'text', text: '' },
                })
              }
              emit('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: delta.text },
              })
            } else if (typeof delta?.toolUse?.input === 'string') {
              sawToolUse = true
              emit('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: delta.toolUse.input,
                },
              })
            }
            continue
          }

          if (event.contentBlockStop) {
            const index = event.contentBlockStop.contentBlockIndex ?? 0
            openBlocks.delete(index)
            emit('content_block_stop', {
              type: 'content_block_stop',
              index,
            })
            continue
          }

          if (event.messageStop) {
            stopReason = event.messageStop.stopReason
            continue
          }

          if (event.metadata) {
            inputTokens = event.metadata.usage?.inputTokens ?? inputTokens
            outputTokens = event.metadata.usage?.outputTokens ?? outputTokens
          }
        }

        for (const index of openBlocks) {
          emit('content_block_stop', {
            type: 'content_block_stop',
            index,
          })
        }

        const usage = { input_tokens: inputTokens, output_tokens: outputTokens }

        emit('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: translateStopReason(stopReason, sawToolUse),
            stop_sequence: null,
          },
          usage,
        })
        emit('message_stop', {
          type: 'message_stop',
          'amazon-bedrock-invocationMetrics': {
            inputTokenCount: inputTokens,
            outputTokenCount: outputTokens,
            invocationLatency: 0,
            firstByteLatency: 0,
          },
          usage,
        })
        controller.close()
      } catch (error) {
        emit('error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: getErrorMessage(error, 'Bedrock ConverseStream error'),
          },
        })
        controller.close()
      }
    },
  })

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'x-request-id': messageId,
    },
  })
}

async function parseAnthropicBody(init?: RequestInit): Promise<Record<string, unknown>> {
  try {
    const bodyText =
      init?.body instanceof ReadableStream
        ? await new Response(init.body).text()
        : typeof init?.body === 'string'
          ? init.body
          : init?.body
            ? await new Response(init.body as BodyInit).text()
            : '{}'
    return JSON.parse(bodyText)
  } catch {
    return {}
  }
}

function createBedrockErrorResponse(status: number, error: unknown): Response {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown Bedrock Converse error'
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'api_error',
        message: `Bedrock Converse error: ${message}`,
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

export function createBedrockConverseFetch(
  runtimeClientFactory: BedrockRuntimeClientFactory = async () =>
    (await createBedrockRuntimeClient()) as BedrockRuntimeClientLike,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    // count_tokens answered locally; other URLs pass through. Note:
    // tokenEstimation.ts special-cases Bedrock at :152-160 so this
    // adapter isn't normally reachable for count_tokens; the gate is
    // defensive in case a future caller routes here directly.
    const route = classifyAnthropicMessagesUrl(url)
    if (route === 'count_tokens') {
      return countTokensUnsupportedResponse()
    }
    if (route === 'other') {
      return globalThis.fetch(input, init)
    }

    const anthropicBody = await parseAnthropicBody(init)
    const converseRequest = translateToConverseRequest(anthropicBody)
    const model = converseRequest.modelId || String(anthropicBody.model || '')

    try {
      const client = await runtimeClientFactory()
      const {
        ConverseCommand,
        ConverseStreamCommand,
      } = await import('@aws-sdk/client-bedrock-runtime')

      if (anthropicBody.stream === true) {
        const output = await client.send(
          new ConverseStreamCommand(converseRequest),
        )
        return createAnthropicStreamFromBedrock(output.stream, model)
      }

      const output = await client.send(new ConverseCommand(converseRequest))
      return translateConverseOutputToAnthropic(output, model)
    } catch (error) {
      const status =
        typeof error === 'object' &&
        error !== null &&
        '$metadata' in error &&
        typeof (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode === 'number'
          ? (error as { $metadata: { httpStatusCode: number } }).$metadata
              .httpStatusCode
          : 500
      return createBedrockErrorResponse(status, error)
    }
  }
}

export const bedrockConverseFetchAdapterTestHooks = {
  createAnthropicStreamFromBedrock,
  translateConverseOutputToAnthropic,
  translateToConverseRequest,
}
