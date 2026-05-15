import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_RESPONSES_MODEL,
} from '../../utils/model/providerCapabilities.js'
import { DEFAULT_ANTHROPIC_PROVIDER_MODEL } from './providerCatalog.js'
import type { ProviderId, ProviderProfile } from './types.js'

export const PROVIDER_PROFILES = {
  'anthropic-direct': {
    id: 'anthropic-direct',
    apiProvider: 'firstParty',
    displayName: 'Anthropic API',
    defaultTransport: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_PROVIDER_MODEL,
    env: {
      apiKey: 'ANTHROPIC_API_KEY',
      model: 'ANTHROPIC_MODEL',
    },
  },
  'anthropic-bedrock': {
    id: 'anthropic-bedrock',
    apiProvider: 'bedrock',
    displayName: 'Amazon Bedrock Claude',
    defaultTransport: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_PROVIDER_MODEL,
    env: {
      model: 'ANTHROPIC_MODEL',
    },
  },
  'anthropic-vertex': {
    id: 'anthropic-vertex',
    apiProvider: 'vertex',
    displayName: 'Vertex AI Claude',
    defaultTransport: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_PROVIDER_MODEL,
    env: {
      model: 'ANTHROPIC_MODEL',
    },
  },
  'anthropic-foundry': {
    id: 'anthropic-foundry',
    apiProvider: 'foundry',
    displayName: 'Azure AI Foundry Claude',
    defaultTransport: 'anthropic_messages',
    defaultModel: DEFAULT_ANTHROPIC_PROVIDER_MODEL,
    env: {
      apiKey: 'ANTHROPIC_FOUNDRY_API_KEY',
      model: 'ANTHROPIC_MODEL',
      baseUrl: 'ANTHROPIC_FOUNDRY_BASE_URL',
    },
  },
  'openai-responses': {
    id: 'openai-responses',
    apiProvider: 'openai',
    displayName: 'OpenAI Responses',
    defaultTransport: 'openai_responses',
    defaultModel: DEFAULT_OPENAI_RESPONSES_MODEL,
    env: {
      apiKey: 'OPENAI_API_KEY',
      model: 'OPENAI_MODEL',
      baseUrl: 'OPENAI_BASE_URL',
    },
  },
  'chatgpt-codex': {
    id: 'chatgpt-codex',
    apiProvider: 'openai',
    displayName: 'ChatGPT Codex OAuth',
    defaultTransport: 'chatgpt_codex',
    defaultModel: DEFAULT_CODEX_MODEL,
    env: {
      model: 'OPENAI_MODEL',
    },
  },
  'opencode-go': {
    id: 'opencode-go',
    apiProvider: 'openai',
    displayName: 'OpenCode Go',
    defaultTransport: 'openai_chat_completions',
    defaultModel: '',
    env: {
      apiKey: 'OPENCODE_API_KEY',
      model: 'OPENCODE_MODEL',
      baseUrl: 'OPENCODE_BASE_URL',
    },
  },
  'bedrock-converse': {
    id: 'bedrock-converse',
    apiProvider: 'bedrock',
    displayName: 'Amazon Bedrock Converse',
    defaultTransport: 'bedrock_converse',
    defaultModel: DEFAULT_ANTHROPIC_PROVIDER_MODEL,
    env: {
      model: 'ANTHROPIC_MODEL',
    },
  },
} as const satisfies Record<ProviderId, ProviderProfile>

export function getProviderProfile(
  providerId: string,
): ProviderProfile | undefined {
  return PROVIDER_PROFILES[providerId as ProviderId]
}
