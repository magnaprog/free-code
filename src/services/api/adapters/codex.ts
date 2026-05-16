/**
 * OpenAI Responses / Codex Fetch Adapter
 *
 * Intercepts fetch calls from the Anthropic SDK and routes them to
 * either the official OpenAI Responses API or ChatGPT's Codex backend,
 * translating between Anthropic Messages API and Responses API shapes.
 *
 * Supports:
 * - Text messages (user/assistant)
 * - System prompts → instructions
 * - Tool definitions (Anthropic input_schema → OpenAI parameters)
 * - Tool use (tool_use → function_call, tool_result → function_call_output)
 * - Streaming events translation
 *
 * Endpoints:
 * - https://api.openai.com/v1/responses
 * - https://chatgpt.com/backend-api/codex/responses
 */

import { randomUUID } from 'crypto'
import {
  getCodexOAuthTokens,
  getFreshCodexOAuthTokens,
} from '../../../utils/auth.js'
import {
  CHATGPT_CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  isKnownOpenAIResponsesModel,
} from '../../../utils/model/providerCapabilities.js'
import { redactSecrets } from '../../../utils/redaction.js'
import { readProviderErrorBody } from './adapterUtils.js'

const MAX_BUFFERED_TOOL_ARGUMENT_CHARS = 64_000

// ── Available Codex models ──────────────────────────────────────────
export const CODEX_MODELS = CHATGPT_CODEX_MODELS.map(m => ({
  id: m.id,
  label: m.id,
  description: `${m.provider} model`,
})) as Array<{ id: string; label: string; description: string }>

const OPENAI_REASONING_CACHE_LIMIT = 200
const reasoningItemsByToolCallId = new Map<string, Record<string, unknown>[]>()

function isOfficialOpenAIResponsesUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'api.openai.com' &&
      parsed.username === '' &&
      parsed.password === '' &&
      (parsed.port === '' || parsed.port === '443')
    )
  } catch {
    return false
  }
}

/**
 * Preserves known OpenAI Responses IDs and maps legacy Claude defaults to
 * equivalent Codex-family fallbacks.
 * @param claudeModel - The Claude model name to map
 * @returns The corresponding Codex model ID
 */
type TranslationOptions = {
  preserveOpenAIResponsesModelIds?: boolean
  targetBackend?: 'openai-responses' | 'chatgpt-codex'
  mapModel?: (model: string) => string
}

export function mapClaudeModelToCodex(
  claudeModel: string | null,
  options: TranslationOptions = {},
): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (claudeModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return claudeModel
  }
  const preserveOpenAIResponsesModelIds =
    options.preserveOpenAIResponsesModelIds ?? true
  if (
    preserveOpenAIResponsesModelIds &&
    isKnownOpenAIResponsesModel(claudeModel)
  ) {
    return claudeModel
  }
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  const isClaudeFamilyModel =
    lower === 'opus' ||
    lower === 'haiku' ||
    lower === 'sonnet' ||
    lower.startsWith('claude-') ||
    lower.startsWith('anthropic.claude')
  if (isClaudeFamilyModel) {
    if (lower.includes('haiku')) return 'gpt-5.4-mini'
    return DEFAULT_CODEX_MODEL
  }
  if (options.targetBackend === 'openai-responses') {
    return claudeModel
  }
  if (options.targetBackend === 'chatgpt-codex' && lower.startsWith('gpt-')) {
    return claudeModel
  }
  return DEFAULT_CODEX_MODEL
}

/**
 * Checks if a given model string is a valid Codex model.
 * @param model - The model string to check
 * @returns True if the model is a Codex model, false otherwise
 */
export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

// Route classification shared with other adapters.
import {
  classifyAnthropicMessagesUrl,
  countTokensUnsupportedResponse,
} from '../anthropicMessagesPath.js'

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>
  } catch {
    return { ...record }
  }
}

function createFallbackToolUseIdFactory(): () => string {
  let counter = 0
  return () => {
    counter += 1
    return `toolu_fallback_${counter}`
  }
}

function rememberReasoningItemsForToolCall(
  callId: unknown,
  reasoningItems: Record<string, unknown>[],
): void {
  if (typeof callId !== 'string' || reasoningItems.length === 0) {
    return
  }

  reasoningItemsByToolCallId.set(callId, reasoningItems.map(cloneRecord))
  while (reasoningItemsByToolCallId.size > OPENAI_REASONING_CACHE_LIMIT) {
    const oldestKey = reasoningItemsByToolCallId.keys().next().value
    if (!oldestKey) break
    reasoningItemsByToolCallId.delete(oldestKey)
  }
}

function getCachedReasoningItemsForToolCall(
  callId: string,
): Record<string, unknown>[] {
  return (reasoningItemsByToolCallId.get(callId) || []).map(cloneRecord)
}

type OpenAIReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'

export function mapFreeCodeEffortToOpenAIReasoningEffort(
  value: unknown,
): OpenAIReasoningEffort | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  switch (value.toLowerCase()) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value.toLowerCase() as OpenAIReasoningEffort
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

// ── JWT helpers ─────────────────────────────────────────────────────

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extracts the account ID from a Codex JWT token.
 * @param token - The JWT token to extract the account ID from
 * @returns The account ID
 * @throws Error if the token is invalid or account ID cannot be extracted
 */
function extractAccountId(token: string): string {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid token')
    const payload = JSON.parse(atob(parts[1]))
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (!accountId) throw new Error('No account ID in token')
    return accountId
  } catch {
    throw new Error('Failed to extract account ID from Codex token')
  }
}

// ── Types ───────────────────────────────────────────────────────────

interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
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

// ── Tool translation: Anthropic → Codex ─────────────────────────────

/**
 * Translates Anthropic tool definitions to Codex format.
 * @param anthropicTools - Array of Anthropic tool definitions
 * @returns Array of Codex-compatible tool objects
 */
function translateTools(anthropicTools: AnthropicTool[]): Array<Record<string, unknown>> {
  return anthropicTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: tool.input_schema || { type: 'object', properties: {} },
    strict: false,
  }))
}

// ── Message translation: Anthropic → Codex input ────────────────────

/**
 * Translates Anthropic message format to Codex input format.
 * Handles text content, tool results, and image attachments.
 * @param anthropicMessages - Array of messages in Anthropic format
 * @returns Array of Codex-compatible input objects
 */
function translateMessages(
  anthropicMessages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const codexInput: Array<Record<string, unknown>> = []
  // Track tool_use IDs to generate call_ids for function_call_output
  // Anthropic uses tool_use_id, Codex uses call_id
  let toolCallCounter = 0

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      codexInput.push({ role: msg.role, content: msg.content })
      continue
    }

    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const contentArr: Array<Record<string, unknown>> = []
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id || `call_${toolCallCounter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text
                if (c.type === 'image') return '[Image data attached]'
                return ''
              })
              .join('\n')
          }
          codexInput.push({
            type: 'function_call_output',
            call_id: callId,
            output: outputText || '',
          })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          contentArr.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          typeof block.source === 'object' &&
          block.source !== null &&
          (block.source as any).type === 'base64'
        ) {
          contentArr.push({
            type: 'input_image',
            image_url: `data:${(block.source as any).media_type};base64,${(block.source as any).data}`,
          })
        }
      }
      if (contentArr.length > 0) {
        if (contentArr.length === 1 && contentArr[0].type === 'input_text') {
          codexInput.push({ role: 'user', content: contentArr[0].text })
        } else {
          codexInput.push({ role: 'user', content: contentArr })
        }
      }
    } else {
      // Process assistant or tool blocks
      const injectedReasoningIds = new Set<string>()
      for (const block of msg.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          if (msg.role === 'assistant') {
            codexInput.push({
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: block.text, annotations: [] }],
              status: 'completed',
            })
          }
        } else if (block.type === 'tool_use') {
          const callId = block.id || `call_${toolCallCounter++}`
          for (const reasoningItem of getCachedReasoningItemsForToolCall(callId)) {
            const key =
              typeof reasoningItem.id === 'string'
                ? reasoningItem.id
                : JSON.stringify(reasoningItem)
            if (!injectedReasoningIds.has(key)) {
              codexInput.push(reasoningItem)
              injectedReasoningIds.add(key)
            }
          }
          codexInput.push({
            type: 'function_call',
            call_id: callId,
            name: block.name || '',
            arguments: JSON.stringify(block.input || {}),
          })
        }
      }
    }
  }

  return codexInput
}

function translateToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return 'auto'
  }

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
        ? { type: 'function', name: choice.name }
        : 'required'
    default:
      return 'auto'
  }
}

function translateOutputFormat(outputConfig: unknown): unknown {
  if (!outputConfig || typeof outputConfig !== 'object') {
    return undefined
  }

  const format = (outputConfig as { format?: unknown }).format
  if (!format || typeof format !== 'object') {
    return undefined
  }

  const typedFormat = format as {
    type?: string
    name?: string
    schema?: Record<string, unknown>
  }
  if (typedFormat.type !== 'json_schema' || !typedFormat.schema) {
    return undefined
  }

  return {
    format: {
      type: 'json_schema',
      name: typedFormat.name || 'structured_output',
      schema: typedFormat.schema,
      strict: true,
    },
  }
}

// ── Full request translation ────────────────────────────────────────

/**
 * Translates a complete Anthropic API request body to Codex format.
 * @param anthropicBody - The Anthropic request body to translate
 * @returns Object containing the translated Codex body and model
 */
function translateToCodexBody(
  anthropicBody: Record<string, unknown>,
  options: TranslationOptions = {},
): {
  codexBody: Record<string, unknown>
  codexModel: string
} {
  const anthropicMessages = (anthropicBody.messages || []) as AnthropicMessage[]
  const systemPrompt = anthropicBody.system as
    | string
    | Array<{ type: string; text?: string; cache_control?: unknown }>
    | undefined
  const claudeModel = anthropicBody.model as string
  const anthropicTools = (anthropicBody.tools || []) as AnthropicTool[]
  const outputConfig = anthropicBody.output_config as
    | Record<string, unknown>
    | undefined
  const targetBackend = options.targetBackend ?? 'openai-responses'
  // ChatGPT's private Codex backend rejects non-streaming calls; for Anthropic
  // non-streaming callers we stream upstream and aggregate back to JSON locally.
  const shouldStream =
    targetBackend === 'chatgpt-codex' ? true : anthropicBody.stream === true

  const mappingOptions = { ...options, targetBackend }
  const codexModel = options.mapModel && claudeModel
    ? options.mapModel(claudeModel)
    : mapClaudeModelToCodex(claudeModel, mappingOptions)
  const reasoningEffort = mapFreeCodeEffortToOpenAIReasoningEffort(
    outputConfig?.effort,
  )

  // Build system instructions
  let instructions = ''
  if (systemPrompt) {
    instructions =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : Array.isArray(systemPrompt)
          ? systemPrompt
              .filter(b => b.type === 'text' && typeof b.text === 'string')
              .map(b => b.text!)
              .join('\n')
          : ''
  }

  // Convert messages
  const input = translateMessages(anthropicMessages)

  const codexBody: Record<string, unknown> = {
    model: codexModel,
    store: false,
    stream: shouldStream,
    instructions,
    input,
  }

  if (anthropicBody.parallel_tool_calls !== undefined) {
    codexBody.parallel_tool_calls = anthropicBody.parallel_tool_calls
  } else if (anthropicTools.length > 0) {
    codexBody.parallel_tool_calls = true
  }

  if (
    targetBackend === 'openai-responses' &&
    typeof anthropicBody.max_tokens === 'number'
  ) {
    codexBody.max_output_tokens = anthropicBody.max_tokens
  }

  if (
    targetBackend === 'openai-responses' &&
    typeof anthropicBody.temperature === 'number'
  ) {
    codexBody.temperature = anthropicBody.temperature
  }

  if (
    targetBackend === 'openai-responses' &&
    Array.isArray(anthropicBody.stop_sequences)
  ) {
    codexBody.stop = anthropicBody.stop_sequences
  }

  const text = translateOutputFormat(outputConfig)
  if (text !== undefined) {
    codexBody.text = text
  }

  if (reasoningEffort !== undefined) {
    codexBody.reasoning = { effort: reasoningEffort }
  }

  if (reasoningEffort !== undefined || anthropicTools.length > 0) {
    codexBody.include = ['reasoning.encrypted_content']
  }

  // Add tools if present
  if (anthropicTools.length > 0) {
    codexBody.tools = translateTools(anthropicTools)
    codexBody.tool_choice = translateToolChoice(anthropicBody.tool_choice)
  }

  return { codexBody, codexModel }
}

// ── Response translation: Codex SSE → Anthropic SSE ─────────────────

/**
 * Formats data as Server-Sent Events (SSE) format.
 * @param event - The event type
 * @param data - The data payload
 * @returns Formatted SSE string
 */
function formatSSE(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  if (typeof error === 'string' && error) {
    return error
  }
  return fallback
}

function getOpenAIResponseErrorMessage(event: Record<string, unknown>): string {
  const response = event.response as Record<string, unknown> | undefined
  const error =
    (response?.error as Record<string, unknown> | undefined) ??
    (event.error as Record<string, unknown> | undefined)
  const message =
    typeof error?.message === 'string'
      ? error.message
      : 'OpenAI Responses stream failed'
  const code =
    typeof error?.code === 'string'
      ? error.code
      : typeof error?.type === 'string'
        ? error.type
        : undefined
  return redactSecrets(code ? `${code}: ${message}` : message)
}

type StreamingToolCall = {
  key: string
  index?: number
  id: string
  name: string
  bufferedArguments: string
  argumentCharsSeen: number
  started: boolean
  stopped: boolean
}

function bufferToolArguments(entry: StreamingToolCall, chunk: string): void {
  if (
    entry.bufferedArguments.length + chunk.length >
    MAX_BUFFERED_TOOL_ARGUMENT_CHARS
  ) {
    throw new Error(
      `OpenAI Responses stream buffered more than ${MAX_BUFFERED_TOOL_ARGUMENT_CHARS} tool argument characters before the tool name arrived`,
    )
  }
  entry.bufferedArguments += chunk
  entry.argumentCharsSeen += chunk.length
}

/**
 * Translates Codex streaming response to Anthropic format.
 * Converts Codex SSE events into Anthropic-compatible streaming events.
 * @param codexResponse - The streaming response from Codex API
 * @param codexModel - The Codex model used for the request
 * @returns Transformed Response object with Anthropic-format stream
 */
async function translateCodexStreamToAnthropic(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const messageId = `msg_codex_${randomUUID()}`
  let downstreamCanceled = false
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const readable = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      let contentBlockIndex = 0
      let outputTokens = 0
      let inputTokens = 0

      // Emit Anthropic message_start
      controller.enqueue(
        encoder.encode(
          formatSSE(
            'message_start',
            JSON.stringify({
              type: 'message_start',
              message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: codexModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
              },
            }),
          ),
        ),
      )

      // Emit ping
      controller.enqueue(
        encoder.encode(
          formatSSE('ping', JSON.stringify({ type: 'ping' })),
        ),
      )

      // Track state for text and tool calls.
      let currentTextBlockStarted = false
      let hadToolCalls = false
      let streamStopReason: 'end_turn' | 'max_tokens' = 'end_turn'
      const pendingReasoningItems: Record<string, unknown>[] = []
      const createFallbackToolUseId = createFallbackToolUseIdFactory()
      const toolCalls = new Map<string, StreamingToolCall>()
      const toolOrder: string[] = []
      let currentToolCallKey: string | undefined

      const closeTextBlock = () => {
        if (!currentTextBlockStarted) return
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex,
            })),
          ),
        )
        contentBlockIndex++
        currentTextBlockStarted = false
      }

      const getToolKey = (
        event: Record<string, unknown>,
        item?: Record<string, unknown>,
      ): string => {
        const key =
          item?.id ??
          event.item_id ??
          event.output_index ??
          item?.call_id ??
          (event as { item?: Record<string, unknown> }).item?.id
        if (key !== undefined && key !== null) return String(key)
        if (currentToolCallKey) return currentToolCallKey
        return `fallback-${toolOrder.length}`
      }

      const getOrCreateToolCall = (
        event: Record<string, unknown>,
        item?: Record<string, unknown>,
      ): StreamingToolCall => {
        const key = getToolKey(event, item)
        let entry = toolCalls.get(key)
        if (!entry) {
          closeTextBlock()
          entry = {
            key,
            id: typeof item?.call_id === 'string'
              ? item.call_id
              : createFallbackToolUseId(),
            name: typeof item?.name === 'string' ? item.name : '',
            bufferedArguments: '',
            argumentCharsSeen: 0,
            started: false,
            stopped: false,
          }
          toolCalls.set(key, entry)
          toolOrder.push(key)
        } else {
          if (typeof item?.call_id === 'string') entry.id = item.call_id
          if (typeof item?.name === 'string') entry.name = item.name
        }
        currentToolCallKey = key
        return entry
      }

      const startToolCallBlock = (entry: StreamingToolCall): boolean => {
        if (entry.started) return true
        if (entry.name.length === 0) return false
        closeTextBlock()
        const index = entry.index ?? contentBlockIndex++
        entry.index = index
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_start', JSON.stringify({
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: entry.id,
                name: entry.name,
                input: {},
              },
            })),
          ),
        )
        entry.started = true
        hadToolCalls = true
        if (entry.bufferedArguments.length > 0) {
          controller.enqueue(
            encoder.encode(
              formatSSE('content_block_delta', JSON.stringify({
                type: 'content_block_delta',
                index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: entry.bufferedArguments,
                },
              })),
            ),
          )
          entry.bufferedArguments = ''
        }
        return true
      }

      const emitToolArguments = (
        entry: StreamingToolCall,
        chunk: string,
      ): void => {
        if (!chunk) return
        if (!entry.started && !startToolCallBlock(entry)) {
          bufferToolArguments(entry, chunk)
          return
        }
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_delta', JSON.stringify({
              type: 'content_block_delta',
              index: entry.index,
              delta: {
                type: 'input_json_delta',
                partial_json: chunk,
              },
            })),
          ),
        )
        entry.argumentCharsSeen += chunk.length
      }

      const mergeToolArguments = (
        entry: StreamingToolCall,
        fullArguments: string,
      ): void => {
        if (fullArguments.length <= entry.argumentCharsSeen) return
        const suffix = fullArguments.startsWith(
          entry.started ? '' : entry.bufferedArguments,
        )
          ? fullArguments.slice(entry.argumentCharsSeen)
          : entry.argumentCharsSeen === 0
            ? fullArguments
            : ''
        emitToolArguments(entry, suffix)
      }

      const finishToolCallBlock = (entry: StreamingToolCall): void => {
        if (
          !startToolCallBlock(entry) ||
          entry.stopped ||
          entry.index === undefined
        ) {
          return
        }
        controller.enqueue(
          encoder.encode(
            formatSSE('content_block_stop', JSON.stringify({
              type: 'content_block_stop',
              index: entry.index,
            })),
          ),
        )
        entry.stopped = true
      }

      try {
        upstreamReader = codexResponse.body?.getReader()
        const reader = upstreamReader
        if (!reader) {
          emitTextBlock(
            controller,
            encoder,
            contentBlockIndex,
            'Error: No response body',
          )
          finishStream(
            controller,
            encoder,
            outputTokens,
            inputTokens,
            false,
            streamStopReason,
          )
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''
        let streamDone = false

        // Flush leftover buffer on `done` so the final SSE frame is
        // processed even when the upstream ends without a trailing
        // `\n`. Codex/OpenAI Responses can emit response.completed
        // (final usage + finish reason) in the last frame.
        while (!streamDone && !downstreamCanceled) {
          const { done, value } = await reader.read()
          if (downstreamCanceled) return
          if (done) {
            buffer += decoder.decode()
            streamDone = true
          } else {
            buffer += decoder.decode(value, { stream: true })
          }
          const lines = buffer.split('\n')
          buffer = streamDone ? '' : lines.pop() || ''

          for (const line of lines) {
            if (downstreamCanceled) return
            const trimmed = line.trim()
            if (!trimmed) continue

            // Parse "event: xxx" lines
            if (trimmed.startsWith('event: ')) continue

            if (!trimmed.startsWith('data: ')) continue
            const dataStr = trimmed.slice(6)
            if (dataStr === '[DONE]') continue

            let event: Record<string, unknown>
            try {
              event = JSON.parse(dataStr)
            } catch {
              continue
            }

            const eventType = event.type as string

            if (eventType === 'response.failed' || eventType === 'error') {
              throw new Error(getOpenAIResponseErrorMessage(event))
            }

            // ── Text output events ──────────────────────────────
            if (eventType === 'response.output_item.added') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'reasoning') {
                // OpenAI exposes reasoning summaries, not Anthropic signed
                // thinking blocks. Do not synthesize Anthropic thinking.
              } else if (item?.type === 'message') {
                closeTextBlock()
              } else if (item?.type === 'function_call') {
                const entry = getOrCreateToolCall(event, item)
                if (typeof item.arguments === 'string') {
                  mergeToolArguments(entry, item.arguments)
                }
              }
            }

            // Text deltas
            else if (
              eventType === 'response.output_text.delta' ||
              eventType === 'response.refusal.delta'
            ) {
              const text = event.delta as string
              if (typeof text === 'string' && text.length > 0) {
                if (!currentTextBlockStarted) {
                  // Start a new text content block
                  controller.enqueue(
                    encoder.encode(
                      formatSSE('content_block_start', JSON.stringify({
                        type: 'content_block_start',
                        index: contentBlockIndex,
                        content_block: { type: 'text', text: '' },
                      })),
                    ),
                  )
                  currentTextBlockStarted = true
                }
                controller.enqueue(
                  encoder.encode(
                    formatSSE('content_block_delta', JSON.stringify({
                      type: 'content_block_delta',
                      index: contentBlockIndex,
                      delta: { type: 'text_delta', text },
                    })),
                  ),
                )
                outputTokens += 1
              }
            }

            // Reasoning deltas
            else if (
              eventType === 'response.reasoning.delta' ||
              eventType === 'response.reasoning_summary_text.delta'
            ) {
              // Intentionally ignored. Anthropic thinking blocks require a
              // signature_delta; OpenAI reasoning summaries do not provide one.
            }

            // ── Tool call argument deltas ───────────────────────
            else if (eventType === 'response.function_call_arguments.delta') {
              const argDelta = event.delta as string
              if (typeof argDelta === 'string') {
                emitToolArguments(getOrCreateToolCall(event), argDelta)
              }
            }

            // Tool call arguments complete
            else if (eventType === 'response.function_call_arguments.done') {
              if (typeof event.arguments === 'string') {
                mergeToolArguments(getOrCreateToolCall(event), event.arguments)
              }
            }

            // Output item done — close blocks
            else if (eventType === 'response.output_item.done') {
              const item = event.item as Record<string, unknown>
              if (item?.type === 'function_call') {
                const entry = getOrCreateToolCall(event, item)
                if (typeof item.arguments === 'string') {
                  mergeToolArguments(entry, item.arguments)
                }
                rememberReasoningItemsForToolCall(item.call_id, pendingReasoningItems)
                finishToolCallBlock(entry)
                if (currentToolCallKey === entry.key) currentToolCallKey = undefined
              } else if (item?.type === 'message') {
                closeTextBlock()
              } else if (item?.type === 'reasoning') {
                pendingReasoningItems.push(cloneRecord(item))
              }
            }

            // Response completed — extract usage
            else if (eventType === 'response.completed') {
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as Record<string, number> | undefined
              if (usage) {
                outputTokens = usage.output_tokens || outputTokens
                inputTokens = usage.input_tokens || inputTokens
              }
            }

            else if (eventType === 'response.incomplete') {
              const response = event.response as Record<string, unknown>
              const usage = response?.usage as Record<string, number> | undefined
              if (usage) {
                outputTokens = usage.output_tokens || outputTokens
                inputTokens = usage.input_tokens || inputTokens
              }
              const incompleteDetails = response?.incomplete_details as
                | { reason?: string }
                | undefined
              if (
                incompleteDetails?.reason === 'max_output_tokens' ||
                incompleteDetails?.reason === 'max_tokens'
              ) {
                streamStopReason = 'max_tokens'
              }
            }
          }
        }
      } catch (err) {
        if (downstreamCanceled) return
        await upstreamReader?.cancel().catch(() => {})
        if (downstreamCanceled) return
        controller.enqueue(
          encoder.encode(
            formatSSE('error', JSON.stringify({
              type: 'error',
              error: {
                type: 'api_error',
                message: getErrorMessage(err, 'OpenAI Responses stream error'),
              },
            })),
          ),
        )
        if (!downstreamCanceled) {
          controller.close()
        }
        return
      }

      if (downstreamCanceled) return

      closeTextBlock()
      for (const key of toolOrder) {
        const entry = toolCalls.get(key)
        if (entry) finishToolCallBlock(entry)
      }

      finishStream(
        controller,
        encoder,
        outputTokens,
        inputTokens,
        hadToolCalls,
        streamStopReason,
      )
    },
    async cancel(reason) {
      downstreamCanceled = true
      await upstreamReader?.cancel(reason).catch(() => {})
    },
  })

  function emitTextBlock(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    index: number,
    text: string,
  ) {
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_start', JSON.stringify({
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        })),
      ),
    )
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_delta', JSON.stringify({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        })),
      ),
    )
    controller.enqueue(
      encoder.encode(
        formatSSE('content_block_stop', JSON.stringify({
          type: 'content_block_stop',
          index,
        })),
      ),
    )
  }

  function finishStream(
    controller: ReadableStreamDefaultController,
    encoder: TextEncoder,
    outputTokens: number,
    inputTokens: number,
    hadToolCalls: boolean,
    streamStopReason: 'end_turn' | 'max_tokens',
  ) {
    // Use 'tool_use' stop reason when model made tool calls
    const stopReason = hadToolCalls ? 'tool_use' : streamStopReason
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens }

    controller.enqueue(
      encoder.encode(
        formatSSE(
          'message_delta',
          JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage,
          }),
        ),
      ),
    )
    controller.enqueue(
      encoder.encode(
        formatSSE(
          'message_stop',
          JSON.stringify({
            type: 'message_stop',
            'amazon-bedrock-invocationMetrics': {
              inputTokenCount: inputTokens,
              outputTokenCount: outputTokens,
              invocationLatency: 0,
              firstByteLatency: 0,
            },
            usage,
          }),
        ),
      ),
    )
    controller.close()
  }

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

async function translateCodexStreamToAnthropicResponse(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const streamResponse = await translateCodexStreamToAnthropic(
    codexResponse,
    codexModel,
  )
  const streamText = await streamResponse.text()
  const requestId =
    streamResponse.headers.get('x-request-id') ?? `msg_codex_${randomUUID()}`
  const content: Array<Record<string, unknown>> = []
  const toolInputBuffers = new Map<number, string>()
  let usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 }
  let stopReason: string | null = null
  let stopSequence: string | null = null

  for (const line of streamText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data: ')) continue

    const dataStr = trimmed.slice(6)
    if (!dataStr || dataStr === '[DONE]') continue

    let event: Record<string, unknown>
    try {
      event = JSON.parse(dataStr)
    } catch {
      continue
    }

    if (event.type === 'error') {
      return new Response(JSON.stringify(event), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (event.type === 'message_start') {
      const message = event.message as Record<string, unknown> | undefined
      const messageUsage = message?.usage as Record<string, number> | undefined
      if (messageUsage) usage = { ...usage, ...messageUsage }
      continue
    }

    if (event.type === 'content_block_start') {
      const index = event.index as number
      const contentBlock = event.content_block as Record<string, unknown>
      content[index] = { ...contentBlock }
      if (contentBlock.type === 'tool_use') {
        toolInputBuffers.set(index, '')
      }
      continue
    }

    if (event.type === 'content_block_delta') {
      const index = event.index as number
      const delta = event.delta as Record<string, unknown>
      const block = content[index]
      if (!block) continue

      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        block.text = `${typeof block.text === 'string' ? block.text : ''}${delta.text}`
      } else if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string'
      ) {
        toolInputBuffers.set(
          index,
          `${toolInputBuffers.get(index) ?? ''}${delta.partial_json}`,
        )
      }
      continue
    }

    if (event.type === 'content_block_stop') {
      const index = event.index as number
      const block = content[index]
      if (block?.type === 'tool_use') {
        const inputJson = toolInputBuffers.get(index) ?? ''
        try {
          block.input = inputJson ? JSON.parse(inputJson) : {}
        } catch {
          block.input = {}
        }
      }
      continue
    }

    if (event.type === 'message_delta') {
      const delta = event.delta as Record<string, unknown> | undefined
      stopReason = (delta?.stop_reason as string | null | undefined) ?? stopReason
      stopSequence =
        (delta?.stop_sequence as string | null | undefined) ?? stopSequence
      const deltaUsage = event.usage as Record<string, number> | undefined
      if (deltaUsage) usage = { ...usage, ...deltaUsage }
      continue
    }

    if (event.type === 'message_stop') {
      const stopUsage = event.usage as Record<string, number> | undefined
      if (stopUsage) usage = { ...usage, ...stopUsage }
    }
  }

  return new Response(
    JSON.stringify({
      id: requestId,
      type: 'message',
      role: 'assistant',
      content: content.filter(Boolean),
      model: codexModel,
      stop_reason: stopReason ?? 'end_turn',
      stop_sequence: stopSequence,
      usage,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    },
  )
}

async function translateCodexResponseToAnthropic(
  codexResponse: Response,
  codexModel: string,
): Promise<Response> {
  const response = (await codexResponse.json()) as Record<string, unknown>
  const content: Array<Record<string, unknown>> = []
  const outputItems = Array.isArray(response.output) ? response.output : []
  let sawToolUse = false
  const pendingReasoningItems: Record<string, unknown>[] = []
  const createFallbackToolUseId = createFallbackToolUseIdFactory()

  for (const item of outputItems) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const output = item as Record<string, unknown>
    if (output.type === 'reasoning') {
      pendingReasoningItems.push(cloneRecord(output))
    } else if (output.type === 'message') {
      const parts = Array.isArray(output.content) ? output.content : []
      for (const part of parts) {
        if (!part || typeof part !== 'object') {
          continue
        }
        const contentPart = part as Record<string, unknown>
        if (
          contentPart.type === 'output_text' &&
          typeof contentPart.text === 'string'
        ) {
          content.push({ type: 'text', text: contentPart.text })
        } else if (
          contentPart.type === 'refusal' &&
          typeof contentPart.refusal === 'string'
        ) {
          content.push({ type: 'text', text: contentPart.refusal })
        }
      }
    } else if (output.type === 'function_call') {
      sawToolUse = true
      rememberReasoningItemsForToolCall(output.call_id, pendingReasoningItems)
      content.push({
        type: 'tool_use',
        id:
          typeof output.call_id === 'string'
            ? output.call_id
            : typeof output.id === 'string'
              ? output.id
              : createFallbackToolUseId(),
        name: typeof output.name === 'string' ? output.name : '',
        input: parseToolInput(output.arguments),
      })
    }
  }

  const usage = response.usage as Record<string, number> | undefined
  const anthropicMessage = {
    id:
      typeof response.id === 'string'
        ? response.id
        : `msg_codex_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: codexModel,
    stop_reason: getAnthropicStopReason(response, sawToolUse),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  }

  return new Response(JSON.stringify(anthropicMessage), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': anthropicMessage.id,
    },
  })
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {}
  }
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function getAnthropicStopReason(
  response: Record<string, unknown>,
  sawToolUse: boolean,
): 'end_turn' | 'max_tokens' | 'tool_use' {
  if (sawToolUse) {
    return 'tool_use'
  }
  const incomplete = response.incomplete_details as
    | { reason?: string }
    | undefined
  if (response.status === 'incomplete' && incomplete?.reason === 'max_output_tokens') {
    return 'max_tokens'
  }
  return 'end_turn'
}

// ── Main fetch interceptor ──────────────────────────────────────────

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex/responses'
const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1/responses'

/**
 * Creates a fetch function that intercepts Anthropic API calls and routes them to Codex.
 * @param accessToken - The Codex access token for authentication
 * @returns A fetch function that translates Anthropic requests to Codex format
 */
export function createCodexFetch(
  accessToken: string,
  upstreamFetch: typeof globalThis.fetch = globalThis.fetch,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)

    // count_tokens must be answered locally — forwarding would POST
    // prompt/tool body to api.anthropic.com. Other non-create URLs
    // pass through unchanged.
    const route = classifyAnthropicMessagesUrl(url)
    if (route === 'count_tokens') {
      return countTokensUnsupportedResponse()
    }
    if (route === 'other') {
      return upstreamFetch(input, init)
    }

    // Parse the Anthropic request body
    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const anthropicWantsStream = anthropicBody.stream === true

    // Translate to Codex format
    const { codexBody, codexModel } = translateToCodexBody(anthropicBody, {
      preserveOpenAIResponsesModelIds: false,
      targetBackend: 'chatgpt-codex',
    })

    const callCodex = async (forceRefresh: boolean): Promise<Response> => {
      const freshTokens = await getFreshCodexOAuthTokens(forceRefresh)
      const tokens = freshTokens || getCodexOAuthTokens()
      const currentToken = tokens?.accessToken || accessToken
      const accountId = tokens?.accountId || extractAccountId(currentToken)
      return upstreamFetch(CODEX_BASE_URL, {
        ...init,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: codexBody.stream ? 'text/event-stream' : 'application/json',
          Authorization: `Bearer ${currentToken}`,
          'chatgpt-account-id': accountId,
          originator: 'pi',
          'OpenAI-Beta': 'responses=experimental',
        },
        body: JSON.stringify(codexBody),
        // Forward CLI abort signal so Ctrl-C tears down the upstream
        // streaming connection instead of leaking it.
        signal: init?.signal,
      })
    }

    // Call Codex API
    let codexResponse = await callCodex(false)
    if (codexResponse.status === 401) {
      codexResponse = await callCodex(true)
    }

    if (!codexResponse.ok) {
      const errorText = await readProviderErrorBody(codexResponse)
      const errorBody = {
        type: 'error',
        error: {
          type: 'api_error',
          message: `Codex API error (${codexResponse.status}): ${redactSecrets(errorText)}`,
        },
      }
      return new Response(JSON.stringify(errorBody), {
        status: codexResponse.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (anthropicWantsStream) {
      return translateCodexStreamToAnthropic(codexResponse, codexModel)
    }

    return translateCodexStreamToAnthropicResponse(codexResponse, codexModel)
  }
}

export function createOpenAIResponsesFetch(
  apiKey: string,
  baseUrl = process.env.OPENAI_BASE_URL || OPENAI_RESPONSES_BASE_URL,
  options: TranslationOptions & {
    // When the caller is OpenCode Zen (not OpenAI direct), suppress
    // OpenAI-specific metadata headers (org/project). Sending them to
    // OpenCode leaks the user's OpenAI account identity to a third-
    // party gateway.
    suppressOpenAIMetadata?: boolean
    upstreamFetch?: typeof globalThis.fetch
  } = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const {
    upstreamFetch: upstreamFetchOverride,
    suppressOpenAIMetadata,
    ...translationOptions
  } = options
  const upstreamFetch = upstreamFetchOverride ?? globalThis.fetch
  const responsesUrl = baseUrl.endsWith('/responses')
    ? baseUrl
    : `${baseUrl.replace(/\/$/, '')}/responses`

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const route = classifyAnthropicMessagesUrl(url)
    if (route === 'count_tokens') {
      return countTokensUnsupportedResponse()
    }
    if (route === 'other') {
      return upstreamFetch(input, init)
    }

    let anthropicBody: Record<string, unknown>
    try {
      const bodyText =
        init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : typeof init?.body === 'string'
            ? init.body
            : '{}'
      anthropicBody = JSON.parse(bodyText)
    } catch {
      anthropicBody = {}
    }

    const { codexBody, codexModel } = translateToCodexBody(anthropicBody, {
      ...translationOptions,
      preserveOpenAIResponsesModelIds: true,
      targetBackend: 'openai-responses',
    })
    const shouldSendOpenAIMetadata =
      !suppressOpenAIMetadata && isOfficialOpenAIResponsesUrl(responsesUrl)
    const openAIResponse = await upstreamFetch(responsesUrl, {
      ...init,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: codexBody.stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(shouldSendOpenAIMetadata &&
          process.env.OPENAI_ORG_ID && {
            'OpenAI-Organization': process.env.OPENAI_ORG_ID,
          }),
        ...(shouldSendOpenAIMetadata &&
          process.env.OPENAI_PROJECT_ID && {
            'OpenAI-Project': process.env.OPENAI_PROJECT_ID,
          }),
      },
      body: JSON.stringify(codexBody),
      // Forward CLI abort signal so Ctrl-C tears down the upstream
      // streaming connection instead of leaking it.
      signal: init?.signal,
    })

    if (!openAIResponse.ok) {
      const errorText = await readProviderErrorBody(openAIResponse)
      return new Response(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message: `OpenAI API error (${openAIResponse.status}): ${redactSecrets(errorText)}`,
          },
        }),
        {
          status: openAIResponse.status,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }

    if (codexBody.stream === true) {
      return translateCodexStreamToAnthropic(openAIResponse, codexModel)
    }

    return translateCodexResponseToAnthropic(openAIResponse, codexModel)
  }
}

export const codexFetchAdapterTestHooks = {
  mapClaudeModelToCodex,
  translateCodexStreamToAnthropic,
  translateToCodexBody,
  translateCodexResponseToAnthropic,
}
