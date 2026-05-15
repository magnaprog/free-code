import { afterEach, describe, expect, test } from 'bun:test'
import { createOpenAIChatCompletionsFetch } from './openai-chat-completions-fetch-adapter.js'

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

  // B15: orphan tool_result blocks (no matching prior tool_use) get
  // dropped from the `tool` role and re-surfaced as user text with a
  // clear marker, so the model still sees the information without OpenAI
  // returning 400 on orphan tool messages.
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

  // B16: consecutive same-role messages coalesce. Strict gateways
  // require alternating roles.
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

  // B18: tool schemas get `additionalProperties: false` injected when
  // missing, so strict gateways accept them.
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

  // M1: claude- prefixed models are no longer eagerly rejected — the
  // upstream gateway decides whether the alias is supported. Verify the
  // adapter does call upstream (i.e. doesn't short-circuit) for claude-*.
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
