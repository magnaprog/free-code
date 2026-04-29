import { describe, expect, test } from 'bun:test'
import { getContextWindowForModel, getModelMaxOutputTokens } from '../context.js'
import {
  applyBedrockRegionPrefix,
  getBedrockRegionPrefix,
  isFoundationModel,
} from './bedrock.js'
import {
  CHATGPT_CODEX_MODELS,
  getRequiredNonClaudeAdapterForModel,
} from './providerCapabilities.js'

function withOpenAIEnv(
  provider: string | undefined,
  apiKey: string | undefined,
  callback: () => void,
): void {
  const previousProvider = process.env.CLAUDE_CODE_USE_OPENAI
  const previousOpenAIKey = process.env.OPENAI_API_KEY

  if (provider === undefined) {
    delete process.env.CLAUDE_CODE_USE_OPENAI
  } else {
    process.env.CLAUDE_CODE_USE_OPENAI = provider
  }

  if (apiKey === undefined) {
    delete process.env.OPENAI_API_KEY
  } else {
    process.env.OPENAI_API_KEY = apiKey
  }

  try {
    callback()
  } finally {
    if (previousProvider === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = previousProvider
    }

    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey
    }
  }
}

describe('provider capability adapter routing', () => {
  test('keeps Claude Bedrock models on the Anthropic Bedrock path', () => {
    expect(
      getRequiredNonClaudeAdapterForModel(
        'bedrock',
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
      ),
    ).toBeNull()
    expect(
      getRequiredNonClaudeAdapterForModel('bedrock', 'claude-sonnet-4-6'),
    ).toBeNull()
  })

  test('routes non-Claude Bedrock model IDs to Converse', () => {
    expect(
      getRequiredNonClaudeAdapterForModel('bedrock', 'amazon.nova-pro-v1:0'),
    ).toBe('bedrock-converse')
    expect(
      getRequiredNonClaudeAdapterForModel('bedrock', 'meta.llama3-70b-v1:0'),
    ).toBe('bedrock-converse')
  })

  test('recognizes non-Claude Bedrock base model IDs as foundation models', () => {
    expect(isFoundationModel('amazon.nova-pro-v1:0')).toBe(true)
    expect(isFoundationModel('meta.llama3-70b-v1:0')).toBe(true)
    expect(isFoundationModel('us.amazon.nova-pro-v1:0')).toBe(false)
  })

  test('handles region prefixes for non-Claude Bedrock model IDs', () => {
    expect(getBedrockRegionPrefix('us.amazon.nova-pro-v1:0')).toBe('us')
    expect(applyBedrockRegionPrefix('amazon.nova-pro-v1:0', 'eu')).toBe(
      'eu.amazon.nova-pro-v1:0',
    )
    expect(
      applyBedrockRegionPrefix(
        'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
        'eu',
      ),
    ).toBe(
      'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
    )
  })

  test('uses verified context and output caps for Codex variants', () => {
    withOpenAIEnv(undefined, undefined, () => {
      for (const model of [
        'gpt-5.3-codex',
        'gpt-5.2-codex',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
      ]) {
        expect(getContextWindowForModel(model)).toBe(400_000)
        expect(getModelMaxOutputTokens(model)).toEqual({
          default: 32_000,
          upperLimit: 128_000,
        })
      }
    })
  })

  test('uses verified context and output caps for current OpenAI Responses models', () => {
    withOpenAIEnv(undefined, undefined, () => {
      expect(getContextWindowForModel('gpt-5.5')).toBe(1_050_000)
      expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
      expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
      expect(getModelMaxOutputTokens('gpt-5.5')).toEqual({
        default: 32_000,
        upperLimit: 128_000,
      })
    })
  })

  test('uses ChatGPT Codex catalog and caps when running through Codex OAuth', () => {
    withOpenAIEnv('1', undefined, () => {
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).toContain('gpt-5.5')
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).toContain('gpt-5.4')
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).toContain('gpt-5.4-mini')
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).toContain(
        'gpt-5.3-codex-spark',
      )
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).not.toContain(
        'gpt-5.4-nano',
      )
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).not.toContain(
        'gpt-5.2-codex',
      )
      expect(CHATGPT_CODEX_MODELS.map(m => m.id)).not.toContain(
        'gpt-5.1-codex',
      )
      expect(getContextWindowForModel('gpt-5.5')).toBe(272_000)
      expect(getContextWindowForModel('gpt-5.4')).toBe(272_000)
      expect(getContextWindowForModel('gpt-5.4-mini')).toBe(272_000)
      expect(getContextWindowForModel('gpt-5.3-codex')).toBe(272_000)
      expect(getContextWindowForModel('gpt-5.3-codex-spark')).toBe(128_000)
      expect(getContextWindowForModel('gpt-5.2')).toBe(272_000)
    })
  })
})
