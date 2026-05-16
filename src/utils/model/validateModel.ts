// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import { getRequiredNonClaudeAdapterForModel } from './providerCapabilities.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'
import { getModelStrings } from './modelStrings.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // Check if it's a known alias (these are always valid)
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // Check if it's a known Codex/OpenAI model (skip Anthropic API validation)
  const { isCodexSubscriber } = await import('../auth.js')
  const { isCodexModel } = await import('../../services/api/adapters/codex.js')
  if (isCodexSubscriber() && isCodexModel(normalizedModel)) {
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  }

  // Check if it matches ANTHROPIC_CUSTOM_MODEL_OPTION (pre-validated by the user)
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // OpenCode Zen routing happens before the generic openai-responses check,
  // but ONLY when getAPIProvider() actually selects OpenCode/OpenAI.
  // getAPIProvider precedence is Bedrock > Vertex > Foundry > openai >
  // firstParty (providers.ts:6-17). If a higher-precedence provider env
  // is set, the runtime client dispatches there even when
  // CLAUDE_CODE_USE_OPENCODE_GO=1 is also set, so OpenCode-based
  // validation would accept a model that the runtime actually rejects.
  // Gating on getAPIProvider() === 'openai' keeps validation aligned
  // with runtime dispatch.
  const apiProvider = getAPIProvider()
  if (apiProvider === 'openai') {
    const {
      isOpenCodeGoEnabled,
      getOpenCodeGoApiKey,
      getOpenCodeTransportForModel,
    } = await import('../../services/api/openCodeGo.js')
    if (isOpenCodeGoEnabled() && getOpenCodeGoApiKey()) {
      const transport = getOpenCodeTransportForModel(normalizedModel)
      if (transport === 'gemini_native') {
        return {
          valid: false,
          error: `Model '${normalizedModel}' (Gemini via OpenCode Zen) requires the native /models/{id} adapter, which is not wired yet.`,
        }
      }
      // anthropic_messages, openai_responses, openai_chat_completions all wired.
      validModelCache.set(normalizedModel, true)
      return { valid: true }
    }
  }

  const requiredAdapter = getRequiredNonClaudeAdapterForModel(
    getAPIProvider(),
    normalizedModel,
  )
  const wiredAdapters = new Set([
    ...(process.env.OPENAI_API_KEY ? ['openai-responses'] : []),
    'bedrock-converse',
  ])
  if (requiredAdapter && !wiredAdapters.has(requiredAdapter)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' requires the ${requiredAdapter} adapter, which is not wired yet. Current Vertex and Foundry integrations are Claude-only.`,
    }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }

  // Try to make an actual API call with minimal parameters
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // NotFoundError (404) means the model doesn't exist
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // Generic API error
    return { valid: false, error: `API error: ${error.message}` }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  if (lowerModel.includes('opus-4-7') || lowerModel.includes('opus_4_7')) {
    return getModelStrings().opus46
  }
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}
