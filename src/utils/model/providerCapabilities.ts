import type { APIProvider } from './providers.js'

export type ModelProviderAdapterId =
  | 'anthropic-direct'
  | 'anthropic-bedrock'
  | 'anthropic-vertex'
  | 'anthropic-foundry'
  | 'openai-responses'
  | 'chatgpt-codex'
  | 'bedrock-converse'
  | 'vertex-gemini'
  | 'azure-foundry-inference'

export type ModelCapability = {
  id: string
  provider: ModelProviderAdapterId
  contextWindow?: number
  maxOutputTokens?: number
  supportsTools: boolean
  supportsStreaming: boolean
  supportsStructuredOutputs: boolean
  supportsReasoningEffort: boolean
  supportsTokenCounting: boolean
}

export const OPENAI_RESPONSES_MODELS = [
  {
    id: 'gpt-5.5',
    provider: 'openai-responses',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.4',
    provider: 'openai-responses',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'openai-responses',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.4-nano',
    provider: 'openai-responses',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.3-codex',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.2-codex',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.2',
    provider: 'openai-responses',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.1-codex',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.1-codex-mini',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.1-codex-max',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5-codex',
    provider: 'chatgpt-codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
] as const satisfies readonly ModelCapability[]

export const CHATGPT_CODEX_MODELS = [
  {
    id: 'gpt-5.5',
    provider: 'chatgpt-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.4',
    provider: 'chatgpt-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.4-mini',
    provider: 'chatgpt-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.3-codex',
    provider: 'chatgpt-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.3-codex-spark',
    provider: 'chatgpt-codex',
    contextWindow: 128_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
  {
    id: 'gpt-5.2',
    provider: 'chatgpt-codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsStreaming: true,
    supportsStructuredOutputs: true,
    supportsReasoningEffort: true,
    supportsTokenCounting: false,
  },
] as const satisfies readonly ModelCapability[]

export const DEFAULT_CODEX_MODEL = 'gpt-5.5'
export const DEFAULT_OPENAI_RESPONSES_MODEL = 'gpt-5.5'

export function isKnownOpenAIResponsesModel(model: string): boolean {
  return OPENAI_RESPONSES_MODELS.some(m => m.id === model)
}

export function getKnownNonClaudeModelCapability(
  model: string,
  adapter?: Extract<
    ModelProviderAdapterId,
    'openai-responses' | 'chatgpt-codex'
  >,
): ModelCapability | undefined {
  if (adapter === 'chatgpt-codex') {
    return CHATGPT_CODEX_MODELS.find(m => m.id === model)
  }
  return OPENAI_RESPONSES_MODELS.find(m => m.id === model)
}

export function getAnthropicAdapterId(
  provider: APIProvider,
): ModelProviderAdapterId | null {
  switch (provider) {
    case 'firstParty':
      return 'anthropic-direct'
    case 'bedrock':
      return 'anthropic-bedrock'
    case 'vertex':
      return 'anthropic-vertex'
    case 'foundry':
      return 'anthropic-foundry'
    case 'openai':
      return null
  }
}

export function getRequiredNonClaudeAdapterForModel(
  provider: APIProvider,
  model: string,
): ModelProviderAdapterId | null {
  const m = model.toLowerCase()
  if (provider === 'openai') {
    return 'openai-responses'
  }
  if (
    provider === 'bedrock' &&
    !m.includes('anthropic.claude') &&
    !m.includes('claude-') &&
    !m.includes('/anthropic.claude')
  ) {
    return 'bedrock-converse'
  }
  if (provider === 'vertex' && m.includes('gemini')) {
    return 'vertex-gemini'
  }
  if (
    provider === 'foundry' &&
    !m.includes('claude') &&
    !m.includes('anthropic')
  ) {
    return 'azure-foundry-inference'
  }
  return null
}
