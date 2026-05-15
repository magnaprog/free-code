import type { ModelCapability } from '../../utils/model/providerCapabilities.js'
import type { ProviderCapabilities, ProviderTransport } from './types.js'

export const DEFAULT_ANTHROPIC_PROVIDER_MODEL = 'claude-sonnet-4-6'
export const DEFAULT_PROVIDER_CONTEXT_TOKENS = 200_000
export const DEFAULT_PROVIDER_OUTPUT_TOKENS = 64_000

export const WIRED_PROVIDER_TRANSPORTS = [
  'anthropic_messages',
  'openai_responses',
  'chatgpt_codex',
  'openai_chat_completions',
  'bedrock_converse',
] as const satisfies readonly ProviderTransport[]

export function createAnthropicMessagesCapabilities(
  model: string,
): ProviderCapabilities {
  return {
    transport: 'anthropic_messages',
    supportsTools: true,
    supportsParallelTools: true,
    supportsStreaming: true,
    supportsImages: true,
    supportsPdf: true,
    supportsReasoning: true,
    supportsReasoningEffort: true,
    supportsStructuredOutputs: true,
    supportsPromptCaching: true,
    supportsNativeCompaction: false,
    supportsCacheEdits: true,
    supportsTokenCounting: true,
    requiresStrictJsonSchema: false,
    requiresAlternatingRoles: false,
    acceptsToolResultBlocks: true,
    maxContextTokens: model.toLowerCase().includes('[1m]')
      ? 1_000_000
      : DEFAULT_PROVIDER_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_PROVIDER_OUTPUT_TOKENS,
  }
}

export function createOpenAIResponsesCapabilities(
  model: ModelCapability,
): ProviderCapabilities {
  return {
    transport: 'openai_responses',
    supportsTools: model.supportsTools,
    supportsParallelTools: true,
    supportsStreaming: model.supportsStreaming,
    supportsImages: true,
    supportsPdf: false,
    supportsReasoning: model.supportsReasoningEffort,
    supportsReasoningEffort: model.supportsReasoningEffort,
    supportsStructuredOutputs: model.supportsStructuredOutputs,
    supportsPromptCaching: false,
    supportsNativeCompaction: false,
    supportsCacheEdits: false,
    supportsTokenCounting: model.supportsTokenCounting,
    requiresStrictJsonSchema: true,
    requiresAlternatingRoles: false,
    acceptsToolResultBlocks: true,
    maxContextTokens: model.contextWindow ?? DEFAULT_PROVIDER_CONTEXT_TOKENS,
    maxOutputTokens: model.maxOutputTokens ?? DEFAULT_PROVIDER_OUTPUT_TOKENS,
  }
}

export function createChatGptCodexCapabilities(
  model: ModelCapability,
): ProviderCapabilities {
  return {
    ...createOpenAIResponsesCapabilities(model),
    transport: 'chatgpt_codex',
    supportsPromptCaching: false,
    supportsTokenCounting: false,
  }
}

export function createOpenAIChatCompletionsCapabilities(): ProviderCapabilities {
  return {
    transport: 'openai_chat_completions',
    supportsTools: true,
    supportsParallelTools: true,
    supportsStreaming: true,
    supportsImages: false,
    supportsPdf: false,
    supportsReasoning: false,
    supportsReasoningEffort: false,
    supportsStructuredOutputs: false,
    supportsPromptCaching: false,
    supportsNativeCompaction: false,
    supportsCacheEdits: false,
    supportsTokenCounting: false,
    requiresStrictJsonSchema: false,
    requiresAlternatingRoles: false,
    acceptsToolResultBlocks: true,
    maxContextTokens: DEFAULT_PROVIDER_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_PROVIDER_OUTPUT_TOKENS,
  }
}

export function createBedrockConverseCapabilities(): ProviderCapabilities {
  return {
    transport: 'bedrock_converse',
    supportsTools: true,
    supportsParallelTools: true,
    supportsStreaming: true,
    supportsImages: true,
    supportsPdf: false,
    supportsReasoning: false,
    supportsReasoningEffort: false,
    supportsStructuredOutputs: false,
    supportsPromptCaching: false,
    supportsNativeCompaction: false,
    supportsCacheEdits: false,
    supportsTokenCounting: false,
    requiresStrictJsonSchema: false,
    requiresAlternatingRoles: false,
    acceptsToolResultBlocks: true,
    maxContextTokens: DEFAULT_PROVIDER_CONTEXT_TOKENS,
    maxOutputTokens: DEFAULT_PROVIDER_OUTPUT_TOKENS,
  }
}
