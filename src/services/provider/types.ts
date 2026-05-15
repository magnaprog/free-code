import type { APIProvider } from '../../utils/model/providers.js'
import type { ModelProviderAdapterId } from '../../utils/model/providerCapabilities.js'

export type ProviderId =
  | 'anthropic-direct'
  | 'anthropic-bedrock'
  | 'anthropic-vertex'
  | 'anthropic-foundry'
  | 'openai-responses'
  | 'chatgpt-codex'
  | 'opencode-go'
  | 'bedrock-converse'

export type ProviderTransport =
  | 'anthropic_messages'
  | 'openai_responses'
  | 'chatgpt_codex'
  | 'openai_chat_completions'
  | 'bedrock_converse'

export type ProviderAuth =
  | { type: 'none' }
  | {
      type: 'api'
      key: string
      header?: string
      scheme?: 'bearer' | 'raw'
      metadata?: Record<string, string>
    }
  | {
      type: 'oauth'
      access: string
      refresh?: string
      expires?: number
      accountId?: string
    }

export type ProviderCapabilities = {
  transport: ProviderTransport
  supportsTools: boolean
  supportsParallelTools: boolean
  supportsStreaming: boolean
  supportsImages: boolean
  supportsPdf: boolean
  supportsReasoning: boolean
  supportsReasoningEffort: boolean
  supportsStructuredOutputs: boolean
  supportsPromptCaching: boolean
  supportsNativeCompaction: boolean
  supportsCacheEdits: boolean
  supportsTokenCounting: boolean
  requiresStrictJsonSchema: boolean
  requiresAlternatingRoles: boolean
  acceptsToolResultBlocks: boolean
  maxContextTokens: number
  maxOutputTokens: number
}

export type ProviderCapabilityRequirement = Partial<
  Pick<
    ProviderCapabilities,
    | 'supportsTools'
    | 'supportsParallelTools'
    | 'supportsStreaming'
    | 'supportsImages'
    | 'supportsPdf'
    | 'supportsReasoning'
    | 'supportsReasoningEffort'
    | 'supportsStructuredOutputs'
    | 'supportsPromptCaching'
    | 'supportsNativeCompaction'
    | 'supportsCacheEdits'
    | 'supportsTokenCounting'
    | 'acceptsToolResultBlocks'
  >
>

export type ProviderProfile = {
  id: ProviderId
  apiProvider: APIProvider
  displayName: string
  defaultTransport: ProviderTransport
  defaultModel: string
  env: {
    apiKey?: string
    model?: string
    baseUrl?: string
  }
}

export type ResolvedModelRuntime = {
  providerId: ProviderId
  apiProvider: APIProvider
  model: string
  adapterId: ModelProviderAdapterId
  transport: ProviderTransport
  auth: ProviderAuth
  authSource: string
  capabilities: ProviderCapabilities
  baseUrl?: string
  diagnostics: string[]
}

export type ProviderResolutionFailureReason =
  | 'unknown_provider'
  | 'unknown_model'
  | 'not_implemented'
  | 'unsupported_capability'
  | 'missing_auth'
  | 'missing_base_url'

export type ProviderResolution =
  | { ok: true; runtime: ResolvedModelRuntime }
  | {
      ok: false
      reason: ProviderResolutionFailureReason
      providerId?: string
      model?: string
      adapterId?: ModelProviderAdapterId
      capability?: keyof ProviderCapabilityRequirement
      message: string
    }

export type ProviderAuthMap = Partial<Record<ProviderId, ProviderAuth>>
