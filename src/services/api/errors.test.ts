import { describe, expect, test } from 'bun:test'
import {
  classifyAPIError,
  getAssistantMessageFromError,
  isContextLimitError,
  isContextLimitErrorText,
  isPromptTooLongMessage,
} from './errors.js'

describe('context-limit error detection', () => {
  test('recognizes Claude and OpenAI context-limit wording', () => {
    expect(
      isContextLimitErrorText(
        'Prompt is too long: 201000 tokens > 200000 maximum',
      ),
    ).toBe(true)
    expect(
      isContextLimitErrorText(
        "context_length_exceeded: This model's maximum context length is 128000 tokens",
      ),
    ).toBe(true)
    expect(
      isContextLimitErrorText(
        'OpenAI API error (400): {"error":{"code":"context_length_exceeded","message":"maximum context length exceeded"}}',
      ),
    ).toBe(true)
    expect(
      isContextLimitErrorText(
        'Codex API error (400): too many input tokens in the request',
      ),
    ).toBe(true)
    expect(isContextLimitErrorText('input tokens exceed the context limit')).toBe(
      true,
    )
  })

  test('does not treat unrelated token errors as context-limit errors', () => {
    expect(
      isContextLimitErrorText('max_output_tokens reached while generating'),
    ).toBe(false)
    expect(isContextLimitErrorText('rate limit exceeded for input tokens')).toBe(
      false,
    )
    expect(isContextLimitErrorText('invalid API key')).toBe(false)
  })

  test('recognizes structured context-limit errors', () => {
    expect(
      isContextLimitError({
        error: {
          code: 'context_length_exceeded',
          message: 'maximum context length exceeded',
        },
      }),
    ).toBe(true)
  })

  test('normalizes context-limit errors to prompt-too-long assistant messages', () => {
    const message = getAssistantMessageFromError(
      new Error(
        'OpenAI API error (400): context_length_exceeded: maximum context length exceeded',
      ),
      'gpt-5.5',
    )

    expect(isPromptTooLongMessage(message)).toBe(true)
    expect(message.errorDetails).toContain('context_length_exceeded')
    expect(classifyAPIError(new Error('context_length_exceeded'))).toBe(
      'prompt_too_long',
    )
  })
})
