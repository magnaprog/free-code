import { describe, expect, test } from 'bun:test'
import {
  codexFetchAdapterTestHooks,
  createCodexFetch,
  isCodexModel,
} from './codex.js'

function sseResponse(events: Record<string, unknown>[]): Response {
  return sseResponseRaw(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  )
}

function sseResponseRaw(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

function parseSseData(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

describe('codex fetch adapter translation', () => {
  test('recognizes ChatGPT Codex backend model IDs', () => {
    expect(isCodexModel('gpt-5.5')).toBe(true)
    expect(isCodexModel('gpt-5.4')).toBe(true)
    expect(isCodexModel('gpt-5.4-mini')).toBe(true)
    expect(isCodexModel('gpt-5.3-codex')).toBe(true)
    expect(isCodexModel('gpt-5.3-codex-spark')).toBe(true)
    expect(isCodexModel('gpt-5.2')).toBe(true)
    expect(isCodexModel('gpt-5.4-nano')).toBe(false)
    expect(isCodexModel('gpt-5.2-codex')).toBe(false)
    expect(isCodexModel('gpt-5.1-codex')).toBe(false)
  })

  test('preserves explicit OpenAI Responses model IDs', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody({
        model: 'gpt-5.5',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      })

    expect(codexModel).toBe('gpt-5.5')
    expect(codexBody.model).toBe('gpt-5.5')
    expect(codexBody).not.toHaveProperty('tool_choice')
  })

  test('applies explicit model mapper before OpenAI Responses translation', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody(
        {
          model: 'opencode/gpt-5.4-mini',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        },
        { mapModel: model => model.replace(/^opencode\//, '') },
      )

    expect(codexModel).toBe('gpt-5.4-mini')
    expect(codexBody.model).toBe('gpt-5.4-mini')
  })

  test('preserves ChatGPT Codex-supported GPT IDs on the private backend', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody(
        {
          model: 'gpt-5.5',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        },
        { preserveOpenAIResponsesModelIds: false },
      )

    expect(codexModel).toBe('gpt-5.5')
    expect(codexBody.model).toBe('gpt-5.5')
  })

  test('maps Claude aliases only to ChatGPT Codex-supported models', () => {
    expect(codexFetchAdapterTestHooks.mapClaudeModelToCodex('opus')).toBe(
      'gpt-5.5',
    )
    expect(codexFetchAdapterTestHooks.mapClaudeModelToCodex('haiku')).toBe(
      'gpt-5.4-mini',
    )
    expect(codexFetchAdapterTestHooks.mapClaudeModelToCodex('sonnet')).toBe(
      'gpt-5.5',
    )
  })

  test('does not silently remap unsupported explicit GPT IDs on the private backend', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody(
        {
          model: 'gpt-5.2-codex',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        },
        {
          preserveOpenAIResponsesModelIds: false,
          targetBackend: 'chatgpt-codex',
        },
      )

    expect(codexModel).toBe('gpt-5.2-codex')
    expect(codexBody.model).toBe('gpt-5.2-codex')
  })

  test('maps Anthropic request controls to Responses fields', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody({
        model: 'claude-sonnet-4-6',
        stream: false,
        max_tokens: 1234,
        temperature: 0.2,
        stop_sequences: ['</done>'],
        tool_choice: { type: 'tool', name: 'Read' },
        output_config: {
          effort: 'max',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { ok: { type: 'boolean' } },
              required: ['ok'],
            },
          },
        },
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
        messages: [{ role: 'user', content: 'hello' }],
      })

    expect(codexModel).toBe('gpt-5.5')
    expect(codexBody.stream).toBe(false)
    expect(codexBody.max_output_tokens).toBe(1234)
    expect(codexBody.temperature).toBe(0.2)
    expect(codexBody.stop).toEqual(['</done>'])
    expect(codexBody.reasoning).toEqual({ effort: 'xhigh' })
    expect(codexBody.include).toEqual(['reasoning.encrypted_content'])
    expect(codexBody.tool_choice).toEqual({ type: 'function', name: 'Read' })
    expect(codexBody.tools).toEqual([
      {
        type: 'function',
        name: 'Read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
        strict: false,
      },
    ])
    expect(codexBody.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'structured_output',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        strict: true,
      },
    })
  })

  test('omits request controls rejected by the ChatGPT Codex backend', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody(
        {
          model: 'claude-sonnet-4-6',
          stream: false,
          max_tokens: 1234,
          temperature: 0.2,
          stop_sequences: ['</done>'],
          output_config: { effort: 'high' },
          messages: [{ role: 'user', content: 'hello' }],
        },
        {
          preserveOpenAIResponsesModelIds: false,
          targetBackend: 'chatgpt-codex',
        },
      )

    expect(codexModel).toBe('gpt-5.5')
    expect(codexBody.model).toBe('gpt-5.5')
    expect(codexBody.stream).toBe(true)
    expect(codexBody).not.toHaveProperty('max_output_tokens')
    expect(codexBody).not.toHaveProperty('temperature')
    expect(codexBody).not.toHaveProperty('stop')
    expect(codexBody.reasoning).toEqual({ effort: 'high' })
  })

  test('uses ChatGPT Codex streaming upstream for non-streaming Anthropic callers', async () => {
    const previousFetch = globalThis.fetch
    const payload = btoa(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
      }),
    )
    const token = `header.${payload}.signature`
    let upstreamBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body ?? '{}'))
      return sseResponse([
        {
          type: 'response.output_item.added',
          item: { type: 'message' },
        },
        { type: 'response.output_text.delta', delta: 'done' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 3, output_tokens: 4 } },
        },
      ])
    }) as typeof fetch

    try {
      const response = await createCodexFetch(token)(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-5.5',
            stream: false,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      )
      const body = await response.json()

      expect(upstreamBody?.stream).toBe(true)
      expect(body.content).toEqual([{ type: 'text', text: 'done' }])
      expect(body.usage).toEqual({ input_tokens: 3, output_tokens: 4 })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('puts final input usage on streaming message_delta', async () => {
    const response = await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
      sseResponse([
        { type: 'response.output_item.added', item: { type: 'message' } },
        { type: 'response.output_text.delta', delta: 'done' },
        {
          type: 'response.completed',
          response: { usage: { input_tokens: 123, output_tokens: 4 } },
        },
      ]),
      'gpt-5.5',
    )

    const text = await response.text()
    const messageDelta = parseSseData(text).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.usage).toEqual({
      input_tokens: 123,
      output_tokens: 4,
    })
  })

  test('flushes final streaming usage without trailing newline', async () => {
    const finalEvent = {
      type: 'response.completed',
      response: { usage: { input_tokens: 321, output_tokens: 9 } },
    }
    const response = await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
      sseResponseRaw(
        [
          { type: 'response.output_item.added', item: { type: 'message' } },
          { type: 'response.output_text.delta', delta: 'done' },
        ]
          .map(event => `data: ${JSON.stringify(event)}\n\n`)
          .join('') + `data: ${JSON.stringify(finalEvent)}`,
      ),
      'gpt-5.5',
    )

    const messageDelta = parseSseData(await response.text()).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.usage).toEqual({
      input_tokens: 321,
      output_tokens: 9,
    })
  })

  test('puts incomplete response usage on streaming message_delta', async () => {
    const response = await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
      sseResponse([
        { type: 'response.output_item.added', item: { type: 'message' } },
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 456, output_tokens: 7 },
          },
        },
      ]),
      'gpt-5.5',
    )

    const text = await response.text()
    const messageDelta = parseSseData(text).find(
      event => event.type === 'message_delta',
    )
    expect(messageDelta?.delta).toEqual({
      stop_reason: 'max_tokens',
      stop_sequence: null,
    })
    expect(messageDelta?.usage).toEqual({
      input_tokens: 456,
      output_tokens: 7,
    })
  })

  test('preserves context-limit details from Codex non-OK responses', async () => {
    const previousFetch = globalThis.fetch
    const payload = btoa(
      JSON.stringify({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct_test' },
      }),
    )
    const token = `header.${payload}.signature`

    globalThis.fetch = (async () =>
      new Response(
        '{"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"},"access_token":"secret"}',
        { status: 400 },
      )) as typeof fetch

    try {
      const response = await createCodexFetch(token)(
        'https://api.anthropic.com/v1/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-5.5',
            stream: false,
            messages: [{ role: 'user', content: 'hello' }],
          }),
        },
      )
      const body = await response.json()

      expect(body.error.message).toContain('context_length_exceeded')
      expect(body.error.message).toContain('maximum context length exceeded')
      expect(body.error.message).not.toContain('secret')
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('preserves context-limit code from streaming response failures', async () => {
    const response = await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
      sseResponse([
        {
          type: 'response.failed',
          response: {
            error: {
              code: 'context_length_exceeded',
              message:
                'maximum context length exceeded with access_token="secret"',
            },
          },
        },
      ]),
      'gpt-5.5',
    )

    const text = await response.text()
    expect(text).toContain('context_length_exceeded')
    expect(text).toContain('maximum context length exceeded')
    expect(text).not.toContain('secret')
  })

  test('translates non-streaming Responses output to Anthropic message shape', async () => {
    const openAIResponse = new Response(
      JSON.stringify({
        id: 'resp_123',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
          {
            type: 'function_call',
            call_id: 'call_123',
            name: 'Edit',
            arguments: '{"file_path":"a.ts"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    )

    const translated =
      await codexFetchAdapterTestHooks.translateCodexResponseToAnthropic(
        openAIResponse,
        'gpt-5.5',
      )
    const body = await translated.json()

    expect(body).toEqual({
      id: 'resp_123',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'done' },
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'Edit',
          input: { file_path: 'a.ts' },
        },
      ],
      model: 'gpt-5.5',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
  })

  test('generates unique fallback tool_use IDs from non-streaming Responses output', async () => {
    const openAIResponse = new Response(
      JSON.stringify({
        id: 'resp_fallback_ids',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'Read',
            arguments: '{"file_path":"a.ts"}',
          },
          {
            type: 'function_call',
            name: 'Read',
            arguments: '{"file_path":"b.ts"}',
          },
        ],
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
    )

    const translated =
      await codexFetchAdapterTestHooks.translateCodexResponseToAnthropic(
        openAIResponse,
        'gpt-5.5',
      )
    const body = await translated.json()

    expect(body.content.map((block: { id?: string }) => block.id)).toEqual([
      'toolu_fallback_1',
      'toolu_fallback_2',
    ])
  })

  test('carries OpenAI reasoning items across tool result turns', async () => {
    const openAIResponse = new Response(
      JSON.stringify({
        id: 'resp_reasoning',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'rs_123',
            summary: [{ type: 'summary_text', text: 'Need a file read.' }],
            encrypted_content: 'enc_123',
          },
          {
            type: 'function_call',
            call_id: 'call_reasoning',
            name: 'Read',
            arguments: '{"file_path":"a.ts"}',
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      }),
    )

    await codexFetchAdapterTestHooks.translateCodexResponseToAnthropic(
      openAIResponse,
      'gpt-5.5',
    )

    const { codexBody } =
      codexFetchAdapterTestHooks.translateToCodexBody({
        model: 'gpt-5.5',
        stream: false,
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_reasoning',
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
                tool_use_id: 'call_reasoning',
                content: 'contents',
              },
            ],
          },
        ],
      })

    expect(codexBody.input).toEqual([
      {
        type: 'reasoning',
        id: 'rs_123',
        summary: [{ type: 'summary_text', text: 'Need a file read.' }],
        encrypted_content: 'enc_123',
      },
      {
        type: 'function_call',
        call_id: 'call_reasoning',
        name: 'Read',
        arguments: '{"file_path":"a.ts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_reasoning',
        output: 'contents',
      },
    ])
  })

  test('translates streaming incomplete responses to max_tokens stop reason', async () => {
    const translated =
      await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
        sseResponse([
          {
            type: 'response.output_item.added',
            item: { type: 'message' },
          },
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'response.refusal.delta', delta: ' refusal' },
          {
            type: 'response.output_item.done',
            item: { type: 'message' },
          },
          {
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 10, output_tokens: 20 },
            },
          },
        ]),
        'gpt-5.5',
      )

    const text = await translated.text()
    expect(text).toContain('"type":"text_delta","text":"partial"')
    expect(text).toContain('"type":"text_delta","text":" refusal"')
    expect(text).toContain('"stop_reason":"max_tokens"')
    expect(text).toContain('"usage":{"input_tokens":10,"output_tokens":20}')
  })

  test('generates unique fallback tool_use IDs from streaming Responses output', async () => {
    const translated =
      await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
        sseResponse([
          {
            type: 'response.output_item.added',
            item: { type: 'function_call', name: 'Read' },
          },
          {
            type: 'response.function_call_arguments.done',
            arguments: '{"file_path":"a.ts"}',
          },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', name: 'Read' },
          },
          {
            type: 'response.output_item.added',
            item: { type: 'function_call', name: 'Read' },
          },
          {
            type: 'response.function_call_arguments.done',
            arguments: '{"file_path":"b.ts"}',
          },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', name: 'Read' },
          },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 1, output_tokens: 2 } },
          },
        ]),
        'gpt-5.5',
      )

    const text = await translated.text()
    expect(text).toContain('"id":"toolu_fallback_1"')
    expect(text).toContain('"id":"toolu_fallback_2"')
  })

  test('translates streaming failures to Anthropic error events', async () => {
    const translated =
      await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
        sseResponse([
          {
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { message: 'model failed' },
            },
          },
        ]),
        'gpt-5.5',
      )

    const text = await translated.text()
    expect(text).toContain('event: error')
    expect(text).toContain('"message":"model failed"')
    expect(text).not.toContain('event: message_stop')
  })

  test('translates generic streaming error events to Anthropic error events', async () => {
    const translated =
      await codexFetchAdapterTestHooks.translateCodexStreamToAnthropic(
        sseResponse([
          {
            type: 'error',
            error: { message: 'stream transport failed' },
          },
        ]),
        'gpt-5.5',
      )

    const text = await translated.text()
    expect(text).toContain('event: error')
    expect(text).toContain('"message":"stream transport failed"')
    expect(text).not.toContain('event: message_stop')
  })
})
