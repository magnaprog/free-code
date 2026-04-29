import { describe, expect, test } from 'bun:test'
import {
  codexFetchAdapterTestHooks,
  isCodexModel,
} from './codex-fetch-adapter.js'

function sseResponse(events: Record<string, unknown>[]): Response {
  return new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('codex fetch adapter translation', () => {
  test('keeps private Codex model recognition scoped to Codex-family IDs', () => {
    expect(isCodexModel('gpt-5.3-codex')).toBe(true)
    expect(isCodexModel('gpt-5.5')).toBe(false)
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

  test('maps official OpenAI model IDs to Codex defaults on the private Codex backend', () => {
    const { codexBody, codexModel } =
      codexFetchAdapterTestHooks.translateToCodexBody(
        {
          model: 'gpt-5.5',
          stream: false,
          messages: [{ role: 'user', content: 'hello' }],
        },
        { preserveOpenAIResponsesModelIds: false },
      )

    expect(codexModel).toBe('gpt-5.3-codex')
    expect(codexBody.model).toBe('gpt-5.3-codex')
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

    expect(codexModel).toBe('gpt-5.3-codex')
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
        'gpt-5.2-codex',
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
      model: 'gpt-5.2-codex',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
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
        'gpt-5.2-codex',
      )

    const text = await translated.text()
    expect(text).toContain('"type":"text_delta","text":"partial"')
    expect(text).toContain('"type":"text_delta","text":" refusal"')
    expect(text).toContain('"stop_reason":"max_tokens"')
    expect(text).toContain('"usage":{"input_tokens":10,"output_tokens":20}')
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
        'gpt-5.2-codex',
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
        'gpt-5.2-codex',
      )

    const text = await translated.text()
    expect(text).toContain('event: error')
    expect(text).toContain('"message":"stream transport failed"')
    expect(text).not.toContain('event: message_stop')
  })
})
