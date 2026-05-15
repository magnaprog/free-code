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

  test('fails before network when model is missing or still Claude-shaped', async () => {
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
    expect(await response.text()).toContain('explicit non-Claude model')
  })
})
