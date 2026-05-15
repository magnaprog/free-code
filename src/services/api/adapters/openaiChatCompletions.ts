import { randomUUID } from 'crypto'
import { normalizeOpenCodeGoModel } from '../openCodeGo.js'
import { redactSecrets } from '../../../utils/redaction.js'
import { logEvent } from '../../analytics/index.js'

// B6: Date.now() has millisecond resolution; concurrent requests collide.
// Use crypto.randomUUID() for stable per-request IDs.
function generateMessageId(): string {
  return `msg_chat_${randomUUID()}`
}

// M3: cap raw image bytes routed through the data-URI inflation path.
// 1MB warn / 5MB hard reject. Base64 inflates by ~1.37x, plus JSON framing.
const IMAGE_WARN_BYTES = 1_000_000
const IMAGE_REJECT_BYTES = 5_000_000

// M13: cap raw provider error bodies so they cannot smuggle arbitrarily
// large prompt echoes back through the error channel.
const MAX_ERROR_BODY_CHARS = 1_000

// Route classification shared with other adapters. See
// `anthropicMessagesPath.ts` for rationale (count_tokens must not be
// forwarded; path-prefixed base URLs must still match).
import {
  classifyAnthropicMessagesUrl,
  countTokensUnsupportedResponse,
} from '../anthropicMessagesPath.js'

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
      if (block.type === 'image') {
        // M2: emit telemetry so callers can detect when image context is
        // discarded (Chat Completions does not support images in tool role).
        logEvent('chat_completions_image_dropped_from_tool_result', {})
        return '[Image attached]'
      }
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
      // M3: guard against image base64 inflation. Reject anything past
      // hard cap; warn near the soft cap. Base64-decoded byte length is
      // ~3/4 of the string length.
      const decodedBytes = Math.floor((block.source.data.length * 3) / 4)
      if (decodedBytes > IMAGE_REJECT_BYTES) {
        logEvent('chat_completions_image_rejected_too_large', {
          decodedBytes,
        })
        // Drop the image but keep a marker so the model knows something
        // was elided rather than silently disappearing context.
        content.push({
          type: 'text',
          text: `[Image dropped — exceeded ${IMAGE_REJECT_BYTES} byte limit]`,
        })
        continue
      }
      if (decodedBytes > IMAGE_WARN_BYTES) {
        logEvent('chat_completions_image_large', { decodedBytes })
      }
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
  // B15: pre-scan to collect every tool_use ID emitted by an assistant
  // message. Any user tool_result whose tool_use_id is NOT in this set
  // is an orphan (the matching tool_use was compacted/pruned/dropped).
  // OpenAI Chat Completions returns 400 on orphan `tool` messages, so
  // we drop them with telemetry and convert their content to a user
  // text block so the model still sees the information.
  const knownToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) {
        knownToolUseIds.add(block.id)
      }
    }
  }

  // B17: track thinking-block drops for telemetry. Chat Completions
  // does not support reasoning continuity; we drop thinking blocks and
  // emit a single event per request so callers can see reasoning loss.
  let thinkingBlocksDropped = 0

  const out: ChatMessage[] = []
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role as ChatMessage['role'], content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const orphanResults: AnthropicContentBlock[] = []
      const validResults: AnthropicContentBlock[] = []
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue
        if (block.tool_use_id && knownToolUseIds.has(block.tool_use_id)) {
          validResults.push(block)
        } else {
          orphanResults.push(block)
        }
      }
      for (const block of validResults) {
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
      if (orphanResults.length > 0) {
        logEvent('chat_completions_orphan_tool_result_dropped', {
          dropped: orphanResults.length,
        })
      }
      const nonToolBlocks = msg.content.filter(
        block => block.type !== 'tool_result',
      )
      // Surface orphan tool_result content as plain user text so the
      // model still has the information (with a marker noting the
      // tool call is missing).
      const orphanText = orphanResults
        .map(block =>
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? contentBlocksToText(block.content)
              : '',
        )
        .filter(Boolean)
        .join('\n')
      const synthOrphanBlocks: AnthropicContentBlock[] =
        orphanText.length > 0
          ? [
              {
                type: 'text',
                text: `[orphan tool_result content — matching tool_use missing from history]\n${orphanText}`,
              },
            ]
          : []
      const userBlocks = [...nonToolBlocks, ...synthOrphanBlocks]
      if (userBlocks.length > 0) {
        out.push({ role: 'user', content: contentBlocksToUserContent(userBlocks) })
      }
      continue
    }

    if (msg.role === 'assistant') {
      const text = msg.content
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
      // B17: count thinking blocks (silently dropped; Chat Completions
      // has no equivalent surface for reasoning continuity).
      for (const block of msg.content) {
        if (block.type === 'thinking') thinkingBlocksDropped++
      }
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

  if (thinkingBlocksDropped > 0) {
    logEvent('chat_completions_thinking_blocks_dropped', {
      dropped: thinkingBlocksDropped,
    })
  }

  // B16: coalesce consecutive same-role messages. Strict gateways
  // (Ollama, LM Studio, some local templates) require alternating
  // user/assistant roles. Merge sequential user→user or assistant→
  // assistant by joining their text content. Tool calls are preserved
  // (assistant messages with tool_calls don't coalesce with bare text
  // assistants — keep them distinct to avoid losing structure).
  return coalesceConsecutiveRoles(out)
}

function coalesceConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const msg of messages) {
    const prev = out[out.length - 1]
    if (
      prev !== undefined &&
      prev.role === msg.role &&
      // Don't coalesce if either message has tool_calls — preserves
      // the assistant→tool→assistant ordering required by tool flow.
      !prev.tool_calls &&
      !msg.tool_calls &&
      // tool role is per-result; never coalesce tool messages.
      prev.role !== 'tool' &&
      msg.role !== 'tool'
    ) {
      prev.content = mergeChatContent(prev.content, msg.content)
      continue
    }
    out.push(msg)
  }
  return out
}

function mergeChatContent(
  a: ChatMessage['content'],
  b: ChatMessage['content'],
): ChatMessage['content'] {
  // Both strings: join with newline.
  if (typeof a === 'string' && typeof b === 'string') {
    return a && b ? `${a}\n${b}` : a || b
  }
  // Either is array: normalize both to arrays and concat.
  const toArray = (
    c: ChatMessage['content'],
  ): Array<Record<string, unknown>> => {
    if (c === null || c === undefined) return []
    if (typeof c === 'string') return c ? [{ type: 'text', text: c }] : []
    return c
  }
  return [...toArray(a), ...toArray(b)]
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: normalizeToolSchema(
        tool.input_schema || { type: 'object', properties: {} },
      ),
    },
  }))
}

/**
 * B18: normalize tool input schemas for strict OpenAI-compatible
 * gateways. Strict providers require `additionalProperties: false` and
 * an explicit `required` array. We don't force strict mode on the
 * request itself (that would break lenient gateways), but we DO
 * normalize the schema shape so it works for both strict and lenient
 * gateways. Specifically:
 *   - All object schemas get `additionalProperties: false` if not set.
 *   - `required` is preserved as-is (don't auto-fill: a missing
 *     `required` means "all properties optional" in JSON Schema, which
 *     is the Anthropic convention).
 *
 * Walks nested object schemas recursively (properties, items, anyOf,
 * oneOf, allOf).
 */
function normalizeToolSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(normalizeToolSchema)

  const obj = schema as Record<string, unknown>
  const out: Record<string, unknown> = { ...obj }

  if (out.type === 'object') {
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false
    }
    if (out.properties && typeof out.properties === 'object') {
      const props = out.properties as Record<string, unknown>
      const normalizedProps: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) {
        normalizedProps[k] = normalizeToolSchema(v)
      }
      out.properties = normalizedProps
    }
  }

  // Recurse into combinators.
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf', 'not']) {
    if (out[key] !== undefined) {
      out[key] = normalizeToolSchema(out[key])
    }
  }

  return out
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
  const id = typeof json.id === 'string' ? json.id : generateMessageId()
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
  // B8: 'content_filter' was previously silently collapsed to 'end_turn',
  // hiding gateway-side moderation from the caller. We cannot add a new
  // stop_reason value without breaking the Anthropic SDK consumer type,
  // so log + telemetry, then surface as end_turn. Downstream callers that
  // want to detect filtered responses must read the telemetry channel.
  if (finishReason === 'content_filter') {
    logEvent('chat_completions_content_filter', {})
    return 'end_turn'
  }
  return 'end_turn'
}

async function translateChatStreamToAnthropic(
  chatResponse: Response,
  model: string,
): Promise<Response> {
  const messageId = generateMessageId()
  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      // B7: track block indices locally. Each unique block (text, or each
      // distinct provider toolCall.index) gets a monotonically increasing
      // local index assigned on first appearance. Previously the code did
      // `contentBlockIndex + provider's toolCall.index` which collided
      // when (a) text was emitted before any tool_call (contentBlockIndex=0,
      // tool at +0=0), or (b) tool indices were not consecutive from 0.
      let nextLocalIndex = 0
      let textLocalIndex: number | undefined = undefined
      let textOpen = false
      let inputTokens = 0
      let outputTokens = 0
      let stopReason: 'end_turn' | 'max_tokens' = 'end_turn'
      type ToolEntry = {
        localIndex: number
        started: boolean
        id: string
        name: string
        arguments: string
      }
      // Map provider toolCall.index → our local block index. Lets us
      // accept non-consecutive or out-of-order provider indices safely.
      const toolByProviderIndex = new Map<number, ToolEntry>()

      const enqueue = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(formatSSE(event, JSON.stringify(data))))
      }

      const closeTextIfOpen = (): void => {
        if (textOpen && textLocalIndex !== undefined) {
          enqueue('content_block_stop', {
            type: 'content_block_stop',
            index: textLocalIndex,
          })
          textOpen = false
        }
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
            // M11: per-event try/catch so one malformed SSE event doesn't
            // kill the entire stream.
            let event: Record<string, unknown>
            try {
              event = JSON.parse(data) as Record<string, unknown>
            } catch {
              continue
            }
            const choice = (Array.isArray(event.choices) ? event.choices[0] : {}) as
              | { delta?: Record<string, unknown>; finish_reason?: string }
              | undefined
            const delta = choice?.delta ?? {}

            // Text content.
            if (typeof delta.content === 'string' && delta.content) {
              if (!textOpen) {
                textLocalIndex = nextLocalIndex++
                enqueue('content_block_start', {
                  type: 'content_block_start',
                  index: textLocalIndex,
                  content_block: { type: 'text', text: '' },
                })
                textOpen = true
              }
              enqueue('content_block_delta', {
                type: 'content_block_delta',
                index: textLocalIndex!,
                delta: { type: 'text_delta', text: delta.content },
              })
            }

            // Tool calls.
            const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
            for (const rawToolCall of toolCalls) {
              if (!rawToolCall || typeof rawToolCall !== 'object') continue
              const toolCall = rawToolCall as Record<string, unknown>
              const providerIdx =
                typeof toolCall.index === 'number' ? toolCall.index : 0
              const fn = toolCall.function as Record<string, unknown> | undefined

              let entry = toolByProviderIndex.get(providerIdx)
              if (!entry) {
                // First time we see this provider index. Close any open
                // text block first — Anthropic streaming convention is
                // sequential blocks, and consumers may not handle text
                // and tool_use blocks open simultaneously.
                closeTextIfOpen()
                entry = {
                  localIndex: nextLocalIndex++,
                  started: false,
                  id:
                    typeof toolCall.id === 'string'
                      ? toolCall.id
                      : `call_${providerIdx}`,
                  name: '',
                  arguments: '',
                }
                toolByProviderIndex.set(providerIdx, entry)
              }

              if (typeof toolCall.id === 'string') entry.id = toolCall.id
              if (typeof fn?.name === 'string') entry.name = fn.name

              // Defer content_block_start until the function name is
              // known. Some gateways stream the index/id in one chunk and
              // the name in a later chunk; emitting tool_use with name:''
              // would create a malformed block that the Anthropic SDK
              // consumer can't fix (block_start cannot be re-issued).
              // Buffer any arguments that arrive before the name; replay
              // them as a single delta once the block is started.
              const canStart = !entry.started && entry.name.length > 0
              if (canStart) {
                enqueue('content_block_start', {
                  type: 'content_block_start',
                  index: entry.localIndex,
                  content_block: {
                    type: 'tool_use',
                    id: entry.id,
                    name: entry.name,
                    input: {},
                  },
                })
                entry.started = true
                if (entry.arguments.length > 0) {
                  enqueue('content_block_delta', {
                    type: 'content_block_delta',
                    index: entry.localIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: entry.arguments,
                    },
                  })
                  // Pre-name buffer replayed; drop the buffer so a long
                  // stream doesn't grow `entry.arguments` linearly with
                  // every subsequent chunk for no benefit.
                  entry.arguments = ''
                }
              }
              if (typeof fn?.arguments === 'string' && fn.arguments) {
                if (entry.started) {
                  // Forwarded immediately; no need to retain in the entry.
                  enqueue('content_block_delta', {
                    type: 'content_block_delta',
                    index: entry.localIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: fn.arguments,
                    },
                  })
                } else {
                  // Buffer until block can start (name still missing).
                  entry.arguments += fn.arguments
                }
              }
            }

            if (choice?.finish_reason === 'length') stopReason = 'max_tokens'
            // B8: surface content_filter to telemetry even in streaming path.
            if (choice?.finish_reason === 'content_filter') {
              logEvent('chat_completions_content_filter', {})
            }
            // M12: most Chat-Completions gateways emit cumulative usage in
            // the final chunk. Some emit per-delta or never emit. Latest
            // value wins; explicitly typed so per-delta gateways are
            // detectable via the diff (telemetry could be added later).
            const usage = event.usage as Record<string, number> | undefined
            if (typeof usage?.prompt_tokens === 'number') {
              inputTokens = usage.prompt_tokens
            }
            if (typeof usage?.completion_tokens === 'number') {
              outputTokens = usage.completion_tokens
            }
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

      closeTextIfOpen()
      let startedToolCount = 0
      for (const entry of toolByProviderIndex.values()) {
        if (!entry.started) continue
        startedToolCount++
        enqueue('content_block_stop', {
          type: 'content_block_stop',
          index: entry.localIndex,
        })
      }
      // Use the count of STARTED entries (i.e. entries that actually
      // emitted a content_block_start). A malformed upstream stream that
      // sent tool_call args but never a function name would have buffered
      // entries that never started; counting them in toolByProviderIndex.size
      // would emit stop_reason: tool_use with no actual tool_use block —
      // inconsistent and breaks consumers that read stop_reason as a
      // signal to look for tool_use blocks.
      enqueue('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: startedToolCount > 0 ? 'tool_use' : stopReason,
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
    // Anthropic SDK calls /v1/messages (create) and
    // /v1/messages/count_tokens via the same client. The create path
    // must be translated to this gateway's transport. count_tokens
    // must be answered locally — forwarding it would POST prompt/tool
    // bodies to api.anthropic.com (cross-backend data leak), not just
    // miss the cost-control fix. Unrelated URLs are passed through.
    const route = classifyAnthropicMessagesUrl(url)
    if (route === 'count_tokens') return countTokensUnsupportedResponse()
    if (route === 'other') return globalThis.fetch(input, init)

    const anthropicBody = await parseAnthropicBody(init)
    const { chatBody, model } = translateToChatBody(anthropicBody)
    // M1: drop the model.startsWith('claude-') blacklist. Some legitimate
    // gateways (LiteLLM, OpenRouter, OpenCode Zen) proxy Claude models via
    // the chat/completions endpoint with alias names that may start with
    // 'claude-'. Let the upstream gateway reject unknown models with its
    // own error. We still guard against empty/sentinel model values.
    if (!model || model === 'model-required') {
      return createErrorResponse(
        400,
        'OpenAI-compatible chat completion provider requires an explicit model',
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
      // M13: cap raw provider error body. Some gateways echo prompt
      // content in error messages; redactSecrets catches headline secrets
      // but won't redact arbitrary prompt content. Truncate aggressively
      // so an error blob can't smuggle large prompt echoes back through
      // the error channel.
      const rawBody = await chatResponse.text()
      const truncated = rawBody.length > MAX_ERROR_BODY_CHARS
        ? `${rawBody.slice(0, MAX_ERROR_BODY_CHARS)}…[truncated ${rawBody.length - MAX_ERROR_BODY_CHARS} chars]`
        : rawBody
      return createErrorResponse(
        chatResponse.status,
        `OpenAI-compatible chat API error (${chatResponse.status}): ${truncated}`,
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
