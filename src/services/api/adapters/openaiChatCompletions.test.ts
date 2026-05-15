import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAIChatCompletionsFetch } from './openaiChatCompletions.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenAI chat completions fetch adapter', () => {
  test('routes Anthropic messages to OpenAI-compatible chat completions', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'chatcmpl_test',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('fake-opencode-key', {
      baseUrl: 'https://opencode.example/zen/go/v1',
    })
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'opencode-go/qwen-test',
        system: 'system prompt',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        stream: false,
      }),
    })

    expect(calls).toHaveLength(1)
    expect(String(calls[0]!.input)).toBe(
      'https://opencode.example/zen/go/v1/chat/completions',
    )
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe(
      'Bearer fake-opencode-key',
    )
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, any>
    expect(body.model).toBe('qwen-test')
    expect(body.messages[0]).toEqual({ role: 'system', content: 'system prompt' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' })
    expect(body.tools[0].function.name).toBe('Read')

    const anthropic = (await response.json()) as Record<string, any>
    expect(anthropic.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(anthropic.usage).toEqual({ input_tokens: 2, output_tokens: 1 })
  })

  test('fails before network when model is missing or sentinel', async () => {
    let called = false
    globalThis.fetch = (() => {
      called = true
      return Promise.resolve(new Response('{}'))
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('fake-opencode-key', {
      baseUrl: 'https://opencode.example/zen/go/v1',
    })
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'opencode-go/model-required',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(called).toBe(false)
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('explicit model')
  })

  // Orphan tool_result blocks cannot be sent as OpenAI `tool` messages.
  // Preserve their content as marked user text instead of dropping it.
  test('drops orphan tool_result and re-surfaces as user text', async () => {
    let bodyText = ''
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodyText = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'x',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen-test',
        messages: [
          // No prior assistant tool_use → tool_result is orphan.
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'orphan-X', content: 'leftover stdout' },
              { type: 'text', text: 'continue' },
            ],
          },
        ],
      }),
    })

    const sent = JSON.parse(bodyText) as { messages: Array<Record<string, unknown>> }
    // No `tool` role message (would cause OpenAI 400).
    expect(sent.messages.some(m => m.role === 'tool')).toBe(false)
    // The orphan content should appear in a user message (with marker).
    const userMsg = sent.messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    const userContent = JSON.stringify(userMsg)
    expect(userContent).toContain('orphan tool_result content')
    expect(userContent).toContain('leftover stdout')
  })

  // Strict gateways require alternating roles, so consecutive same-role
  // messages are coalesced before sending upstream.
  test('coalesces consecutive user-role messages', async () => {
    let bodyText = ''
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodyText = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'x',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen-test',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'user', content: 'second' },
        ],
      }),
    })

    const sent = JSON.parse(bodyText) as { messages: Array<{ role: string; content: string }> }
    const userMsgs = sent.messages.filter(m => m.role === 'user')
    expect(userMsgs.length).toBe(1)
    expect(userMsgs[0]!.content).toContain('first')
    expect(userMsgs[0]!.content).toContain('second')
  })

  // Strict gateways require explicit `additionalProperties: false` in
  // tool schemas.
  test('normalizes tool schema with additionalProperties: false', async () => {
    let bodyText = ''
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      bodyText = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'x',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string' },
              },
              required: ['path'],
            },
          },
        ],
      }),
    })

    const sent = JSON.parse(bodyText) as {
      tools: Array<{ function: { parameters: Record<string, unknown> } }>
    }
    expect(sent.tools[0]!.function.parameters.additionalProperties).toBe(false)
    expect(sent.tools[0]!.function.parameters.type).toBe('object')
  })

  // B7-edge: provider streams tool_call.index + id in chunk 1 and the
  // function.name in chunk 2. Earlier code emitted content_block_start
  // with name: '' immediately, which is malformed for Anthropic SDK
  // consumers (block_start cannot be re-issued). The fix defers the
  // start until the name is known and replays any buffered arguments.
  test('defers tool_use content_block_start until function name is known', async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'call_xyz' }],
            },
            finish_reason: null,
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
            },
            finish_reason: null,
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'Read', arguments: '"/etc/hosts"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      })}`,
      `data: [DONE]`,
    ]
    const sseBody = upstreamChunks.map(c => `${c}\n\n`).join('')

    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }

    // Parse the SSE events emitted to the consumer.
    const events = out
      .split('\n\n')
      .filter(line => line.startsWith('event: '))
      .map(block => {
        const [, dataLine] = block.split('\n')
        const dataPayload = dataLine?.slice('data: '.length)
        return dataPayload ? JSON.parse(dataPayload) : null
      })
      .filter(Boolean) as Array<Record<string, unknown>>

    // Find content_block_start events for tool_use.
    const toolStarts = events.filter(
      e =>
        e.type === 'content_block_start' &&
        (e as { content_block?: { type?: string; name?: string } })
          .content_block?.type === 'tool_use',
    )

    // Exactly one tool_use start. Must have non-empty name.
    expect(toolStarts).toHaveLength(1)
    const block = (toolStarts[0] as {
      content_block: { name: string; id: string }
    }).content_block
    expect(block.name).toBe('Read')
    expect(block.id).toBe('call_xyz')

    // Buffered args must be replayed as a single delta (the args from
    // chunk 2 arrived before the name).
    const toolDeltas = events.filter(
      e =>
        e.type === 'content_block_delta' &&
        (e as { delta?: { type?: string } }).delta?.type === 'input_json_delta',
    )
    const concatenatedJson = toolDeltas
      .map(d => (d as { delta: { partial_json: string } }).delta.partial_json)
      .join('')
    expect(concatenatedJson).toBe('{"path":"/etc/hosts"}')
  })

  // Anthropic SDK calls /v1/messages/count_tokens?beta=true for token
  // estimation. The adapter must NOT translate this as a generation
  // request (cost) and must NOT forward it to the network either,
  // because forwarding would POST the prompt/tool body to
  // api.anthropic.com (cross-backend data leak). Adapter answers
  // count_tokens locally with a structured 404; the SDK throws and
  // tokenEstimation.ts falls back to rough estimation.
  test('answers /v1/messages/count_tokens locally without network', async () => {
    let networkCalled = false
    globalThis.fetch = (() => {
      networkCalled = true
      return Promise.resolve(new Response('should not be called', { status: 500 }))
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    const response = await fetch(
      'https://api.anthropic.com/v1/messages/count_tokens?beta=true',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-sonnet',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )

    // Upstream fetch must NOT have been called — count_tokens body
    // would otherwise leak to api.anthropic.com.
    expect(networkCalled).toBe(false)
    // Local synthetic response: 404 with Anthropic-shaped error body.
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error?: { type?: string } }
    expect(body.error?.type).toBe('not_found_error')
  })

  // Path-prefixed base URL support: ANTHROPIC_BASE_URL=https://proxy/anthropic
  // produces /anthropic/v1/messages. Adapter must classify this as
  // create (not pass-through) and rewrite the upstream URL to the
  // gateway's /chat/completions, not forward it as /anthropic/v1/messages.
  test('translates path-prefixed /anthropic/v1/messages base URLs to chat/completions', async () => {
    let upstreamUrl = ''
    let upstreamBody = ''
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = input instanceof Request ? input.url : String(input)
      upstreamBody = typeof init?.body === 'string' ? init.body : ''
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'x',
            choices: [
              { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    const response = await fetch(
      'https://proxy.example/anthropic/v1/messages',
      {
        method: 'POST',
        body: JSON.stringify({
          model: 'qwen-test',
          system: 'system prompt',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    )

    expect(upstreamUrl).toContain('/chat/completions')
    expect(upstreamUrl).not.toContain('/anthropic/v1/messages')
    const chatBody = JSON.parse(upstreamBody) as {
      model?: string
      system?: string
      max_tokens?: number
      messages?: Array<{ role?: string; content?: string }>
    }
    expect(chatBody).toMatchObject({
      model: 'qwen-test',
      max_tokens: 128,
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(chatBody.system).toBeUndefined()
    expect(response.status).toBe(200)
  })

  // Malformed streams can send tool-call arguments without ever naming the
  // function. That must not produce stop_reason=tool_use unless a tool_use
  // block was actually emitted.
  test('emits end_turn when tool_call has args but no name (no block started)', async () => {
    const upstreamChunks = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_no_name', function: { arguments: '{"x":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      })}`,
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '1}' } }],
            },
            finish_reason: 'stop',
          },
        ],
      })}`,
      `data: [DONE]`,
    ]
    const sseBody = upstreamChunks.map(c => `${c}\n\n`).join('')

    globalThis.fetch = (() => {
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('k', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'qwen-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    })

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let out = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      out += decoder.decode(value, { stream: true })
    }

    const events = out
      .split('\n\n')
      .filter(line => line.startsWith('event: '))
      .map(block => {
        const [, dataLine] = block.split('\n')
        const dataPayload = dataLine?.slice('data: '.length)
        return dataPayload ? JSON.parse(dataPayload) : null
      })
      .filter(Boolean) as Array<Record<string, unknown>>

    // No tool_use block was emitted (name never arrived).
    const toolStarts = events.filter(
      e =>
        e.type === 'content_block_start' &&
        (e as { content_block?: { type?: string } }).content_block?.type ===
          'tool_use',
    )
    expect(toolStarts).toHaveLength(0)

    // message_delta's stop_reason should be end_turn (not tool_use),
    // because no tool_use block was ever started.
    const messageDelta = events.find(e => e.type === 'message_delta')
    expect(messageDelta).toBeDefined()
    expect(
      (messageDelta as { delta: { stop_reason: string } }).delta.stop_reason,
    ).toBe('end_turn')
  })

  // Claude-prefixed aliases may be accepted by gateways; let upstream decide
  // instead of rejecting them locally.
  test('allows claude-prefixed model names to pass through to upstream', async () => {
    let called = false
    globalThis.fetch = (() => {
      called = true
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'chatcmpl_proxied_claude',
            choices: [
              {
                message: { role: 'assistant', content: 'ok' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as typeof globalThis.fetch

    const fetch = createOpenAIChatCompletionsFetch('fake-key', {
      baseUrl: 'https://opencode.example/zen/v1',
    })
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(called).toBe(true)
    expect(response.status).toBe(200)
  })
})
