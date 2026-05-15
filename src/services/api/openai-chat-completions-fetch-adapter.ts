import { normalizeOpenCodeGoModel } from '../provider/openCodeGo.js'
import { redactSecrets } from '../../utils/redaction.js'

type AnthropicContentBlock = {
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
}

type AnthropicMessage = {
  role: string
  content: string | AnthropicContentBlock[]
}

type AnthropicTool = {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<Record<string, unknown>> | null
  tool_call_id?: string
  tool_calls?: Array<Record<string, unknown>>
}

type ChatCompletionFetchOptions = {
  baseUrl: string
  authHeader?: 'Authorization' | 'x-api-key'
  authScheme?: 'bearer' | 'raw'
}

function parseAnthropicBody(init?: RequestInit): Promise<Record<string, unknown>> {
  return (async () => {
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      return JSON.parse(bodyText) as Record<string, unknown>
    } catch {
      return {}
    }
  })()
}

function systemPromptToText(system: unknown): string | undefined {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return undefined
  const text = system
    .filter(
      (block): block is { type: string; text: string } =>
        !!block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n')
  return text || undefined
}

function contentBlocksToText(blocks: AnthropicContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') return block.content
        if (Array.isArray(block.content)) return contentBlocksToText(block.content)
      }
      if (block.type === 'image') return '[Image attached]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function contentBlocksToUserContent(
  blocks: AnthropicContentBlock[],
): string | Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text })
    } else if (
      block.type === 'image' &&
      block.source?.type === 'base64' &&
      block.source.media_type &&
      block.source.data
    ) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      })
    }
  }
  if (content.length === 0) return contentBlocksToText(blocks)
  if (content.length === 1 && content[0]?.type === 'text') {
    return String(content[0].text ?? '')
  }
  return content
}

function translateMessages(messages: AnthropicMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role as ChatMessage['role'], content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const toolResults = msg.content.filter(block => block.type === 'tool_result')
      for (const block of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content:
            typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? contentBlocksToText(block.content)
                : '',
        })
      }
      const nonToolBlocks = msg.content.filter(block => block.type !== 'tool_result')
      if (nonToolBlocks.length > 0) {
        out.push({ role: 'user', content: contentBlocksToUserContent(nonToolBlocks) })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
      const toolCalls = msg.content
        .filter(block => block.type === 'tool_use')
        .map(block => ({
          id: block.id || '',
          type: 'function',
          function: {
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          },
        }))
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
      })
    }
  }
  return out
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }))
}

function translateToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined
  const choice = toolChoice as { type?: string; name?: string }
  switch (choice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'any':
      return 'required'
    case 'tool':
      return choice.name
        ? { type: 'function', function: { name: choice.name } }
        : 'required'
    default:
      return undefined
  }
}

function translateToChatBody(body: Record<string, unknown>): {
  chatBody: Record<string, unknown>
  model: string
} {
  const model = normalizeOpenCodeGoModel(String(body.model || ''))
  const messages = (body.messages || []) as AnthropicMessage[]
  const system = systemPromptToText(body.system)
  const tools = (body.tools || []) as AnthropicTool[]
  const chatMessages = translateMessages(messages)
  if (system) chatMessages.unshift({ role: 'system', content: system })

  const chatBody: Record<string, unknown> = {
    model,
    messages: chatMessages,
    stream: body.stream === true,
  }
  if (typeof body.max_tokens === 'number') chatBody.max_tokens = body.max_tokens
  if (typeof body.temperature === 'number') chatBody.temperature = body.temperature
  if (Array.isArray(body.stop_sequences)) chatBody.stop = body.stop_sequences
  if (body.parallel_tool_calls !== undefined) {
    chatBody.parallel_tool_calls = body.parallel_tool_calls
  }
  if (tools.length > 0) {
    chatBody.tools = translateTools(tools)
    const toolChoice = translateToolChoice(body.tool_choice)
    if (toolChoice !== undefined) chatBody.tool_choice = toolChoice
  }
  return { chatBody, model }
}

function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function getErrorMessage(error: unknown, fallback: string): string {
  return redactSecrets(error instanceof Error && error.message ? error.message : fallback)
}

function createErrorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: redactSecrets(message) },
    }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function parseToolInput(argumentsValue: unknown): Record<string, unknown> {
  if (typeof argumentsValue !== 'string') return {}
  try {
    const parsed = JSON.parse(argumentsValue)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function translateChatResponseToAnthropic(
  chatResponse: Response,
  model: string,
): Promise<Response> {
  const json = (await chatResponse.json()) as Record<string, unknown>
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
    | { message?: Record<string, unknown>; finish_reason?: string }
    | undefined
  const message = choice?.message ?? {}
  const content: Array<Record<string, unknown>> = []
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  }
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== 'object') continue
    const call = toolCall as Record<string, unknown>
    const fn = call.function as Record<string, unknown> | undefined
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' ? call.id : `call_${content.length}`,
      name: typeof fn?.name === 'string' ? fn.name : '',
      input: parseToolInput(fn?.arguments),
    })
  }
  const usage = json.usage as Record<string, number> | undefined
  const id = typeof json.id === 'string' ? json.id : `msg_chat_${Date.now()}`
  return new Response(
    JSON.stringify({
      id,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: toolCalls.length > 0 ? 'tool_use' : getStopReason(choice?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': id } },
  )
}

function getStopReason(
  finishReason: string | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' {
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'stop') return 'end_turn'
  return 'end_turn'
}

async function translateChatStreamToAnthropic(
  chatResponse: Response,
  model: string,
): Promise<Response> {
  const messageId = `msg_chat_${Date.now()}`
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let textStarted = false
      let inputTokens = 0
      let outputTokens = 0
      let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'
      const toolCallBuffers = new Map<
        number,
        { id: string; name: string; arguments: string; started: boolean }
      >()

      const enqueue = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(data))))
      }

      enqueue('message_start', {
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
      enqueue('ping', { type: 'ping' })

      try {
        const reader = chatResponse.body?.getReader()
        if (!reader) throw new Error('OpenAI-compatible stream has no body')
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue
            const event = JSON.parse(data) as Record<string, unknown>
            const choice = (Array.isArray(event.choices) ? event.choices[0] : {}) as
              | { delta?: Record<string, unknown>; finish_reason?: string }
              | undefined
            const delta = choice?.delta ?? {}
            if (typeof delta.content === 'string' && delta.content) {
              if (!textStarted) {
                enqueue('content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                })
                textStarted = true
              }
              enqueue('content_block_delta', {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              })
            }
            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
            for (const rawToolCall of toolCalls) {
              if (!rawToolCall || typeof rawToolCall !== 'object') continue
              const toolCall = rawToolCall as Record<string, unknown>
              const index = typeof toolCall.index === 'number' ? toolCall.index : 0
              const fn = toolCall.function as Record<string, unknown> | undefined
              const current = toolCallBuffers.get(index) ?? {
                id: typeof toolCall.id === 'string' ? toolCall.id : `call_${index}`,
                name: '',
                arguments: '',
                started: false,
              }
              if (typeof toolCall.id === 'string') current.id = toolCall.id
              if (typeof fn?.name === 'string') current.name = fn.name
              if (!current.started) {
                if (textStarted) {
                  enqueue('content_block_stop', {
                    type: 'content_block_stop',
                    index: contentBlockIndex,
                  })
                  contentBlockIndex++
                  textStarted = false
                }
                enqueue('content_block_start', {
                  type: 'content_block_start',
                  index: contentBlockIndex + index,
                  content_block: {
                    type: 'tool_use',
                    id: current.id,
                    name: current.name,
                    input: {},
                  },
                })
                current.started = true
              }
              if (typeof fn?.arguments === 'string' && fn.arguments) {
                current.arguments += fn.arguments
                enqueue('content_block_delta', {
                  type: 'content_block_delta',
                  index: contentBlockIndex + index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: fn.arguments,
                  },
                })
              }
              toolCallBuffers.set(index, current)
            }
            if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
            const usage = event.usage as Record<string, number> | undefined
            inputTokens = usage?.prompt_tokens ?? inputTokens
            outputTokens = usage?.completion_tokens ?? outputTokens
          }
        }
      } catch (error) {
        enqueue('error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: getErrorMessage(error, 'OpenAI-compatible stream error'),
          },
        })
        controller.close()
        return
      }

      if (textStarted) {
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index: contentBlockIndex,
        })
        contentBlockIndex++
      }
      for (const [index, toolCall] of toolCallBuffers) {
        if (!toolCall.started) continue
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index: contentBlockIndex + index,
        })
      }
      enqueue('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: toolCallBuffers.size > 0 ? 'tool_use' : stopReason,
          stop_sequence: null,
        },
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      enqueue('message_stop', {
        type: 'message_stop',
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      })
      controller.close()
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

export function createOpenAIChatCompletionsFetch(
  apiKey: string,
  options: ChatCompletionFetchOptions,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const chatUrl = options.baseUrl.endsWith('/chat/completions')
    ? options.baseUrl
    : `${options.baseUrl.replace(/\/$/, '')}/chat/completions`
  const authHeader = options.authHeader ?? 'Authorization'
  const authValue =
    options.authScheme === 'raw' ? apiKey : `Bearer ${apiKey}`

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    if (!url.includes('/v1/messages')) return globalThis.fetch(input, init)

    const anthropicBody = await parseAnthropicBody(init)
    const { chatBody, model } = translateToChatBody(anthropicBody)
    if (
      !model ||
      model === 'model-required' ||
      model.startsWith('claude-') ||
      model.includes('anthropic.claude')
    ) {
      return createErrorResponse(
        400,
        'OpenAI-compatible chat completion provider requires an explicit non-Claude model',
      )
    }

    const chatResponse = await globalThis.fetch(chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: chatBody.stream === true ? 'text/event-stream' : 'application/json',
        [authHeader]: authValue,
      },
      body: JSON.stringify(chatBody),
    })

    if (!chatResponse.ok) {
      return createErrorResponse(
        chatResponse.status,
        `OpenAI-compatible chat API error (${chatResponse.status}): ${await chatResponse.text()}`,
      )
    }

    if (chatBody.stream === true) {
      return translateChatStreamToAnthropic(chatResponse, model)
    }
    return translateChatResponseToAnthropic(chatResponse, model)
  }
}

export const openAIChatCompletionsFetchAdapterTestHooks = {
  translateToChatBody,
  translateChatResponseToAnthropic,
  translateChatStreamToAnthropic,
}
