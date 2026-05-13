import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentId } from '../../types/ids.js'
import { CLIENT_REQUEST_ID_HEADER } from './client.js'
import {
  buildAnthropicRequestHeaders,
  getMaxOutputTokensErrorMessage,
} from './claude.js'

const originalAttribution = process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION
const originalOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
const originalOpenAIKey = process.env.OPENAI_API_KEY

afterEach(() => {
  if (originalAttribution === undefined) {
    delete process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION
  } else {
    process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION = originalAttribution
  }
  if (originalOpenAI === undefined) {
    delete process.env.CLAUDE_CODE_USE_OPENAI
  } else {
    process.env.CLAUDE_CODE_USE_OPENAI = originalOpenAI
  }
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey
  }
})

describe('Anthropic request headers', () => {
  test('omits empty request headers', () => {
    delete process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION

    expect(buildAnthropicRequestHeaders({})).toBeUndefined()
  })

  test('adds subagent attribution when enabled', () => {
    process.env.FREE_CODE_ENABLE_ANTHROPIC_ATTRIBUTION = 'true'

    expect(
      buildAnthropicRequestHeaders({
        clientRequestId: 'request-1',
        agentId: 'agent-1' as AgentId,
      }),
    ).toEqual({
      [CLIENT_REQUEST_ID_HEADER]: 'request-1',
      'X-Claude-Code-Agent-Id': 'agent-1',
    })
  })

  test('uses provider-neutral max output wording', () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_API_KEY

    expect(getMaxOutputTokensErrorMessage(20_000)).toBe(
      'API Error: The model\'s response exceeded the 20000 output token maximum. To configure this behavior when supported by the selected provider, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.',
    )
  })

  test('explains that ChatGPT Codex streaming ignores max output env override', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = 'true'
    delete process.env.OPENAI_API_KEY

    expect(getMaxOutputTokensErrorMessage(20_000)).toBe(
      'API Error: The selected backend stopped after reaching its output token maximum. ChatGPT Codex streaming does not accept CLAUDE_CODE_MAX_OUTPUT_TOKENS.',
    )
  })
})
