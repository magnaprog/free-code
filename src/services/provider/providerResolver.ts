import type { APIProvider } from '../../utils/model/providers.js'
import {
  getKnownNonClaudeModelCapability,
  getRequiredNonClaudeAdapterForModel,
  type ModelProviderAdapterId,
} from '../../utils/model/providerCapabilities.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { ProviderAuthStore } from './authStore.js'
import {
  createAnthropicMessagesCapabilities,
  createBedrockConverseCapabilities,
  createChatGptCodexCapabilities,
  createOpenAIChatCompletionsCapabilities,
  createOpenAIResponsesCapabilities,
} from './providerCatalog.js'
import {
  getOpenCodeGoApiKey,
  getOpenCodeGoBaseUrl,
  getOpenCodeGoModel,
  isOpenCodeGoEnabled,
} from './openCodeGo.js'
import { getProviderProfile } from './providerProfiles.js'
import type {
  ProviderAuth,
  ProviderAuthMap,
  ProviderCapabilityRequirement,
  ProviderId,
  ProviderResolution,
  ResolvedModelRuntime,
} from './types.js'

export type ProviderResolverEnv = Record<string, string | undefined>

export type CodexOAuthTokensForResolver = {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: number | null
  accountId?: string | null
}

export type ResolveProviderRuntimeOptions = {
  providerId?: string
  apiProvider?: APIProvider
  model?: string
  env?: ProviderResolverEnv
  authByProviderId?: ProviderAuthMap
  codexOAuthTokens?: CodexOAuthTokensForResolver | null
  requiredCapabilities?: ProviderCapabilityRequirement
}

export async function resolveProviderRuntimeFromAuthStore(
  options: Omit<ResolveProviderRuntimeOptions, 'authByProviderId'> & {
    authStore?: ProviderAuthStore
  } = {},
): Promise<ProviderResolution> {
  const authStore = options.authStore ?? new ProviderAuthStore()
  return resolveProviderRuntime({
    ...options,
    authByProviderId: await authStore.read(),
  })
}

export function resolveProviderRuntime(
  options: ResolveProviderRuntimeOptions = {},
): ProviderResolution {
  const env = options.env ?? process.env
  const explicitProfile = options.providerId
    ? getProviderProfile(options.providerId)
    : undefined

  if (options.providerId && !explicitProfile) {
    return fail('unknown_provider', {
      providerId: options.providerId,
      message: `Unknown provider '${options.providerId}'`,
    })
  }

  if (explicitProfile?.id === 'openai-responses') {
    return resolveOpenAIResponses(options, env, explicitProfile.id)
  }
  if (explicitProfile?.id === 'chatgpt-codex') {
    return resolveChatGptCodex(options, env, explicitProfile.id)
  }
  if (explicitProfile?.id === 'opencode-go') {
    return resolveOpenCodeGo(options, env, explicitProfile.id)
  }
  if (explicitProfile?.id === 'bedrock-converse') {
    return withCapabilityCheck(
      createRuntime({
        providerId: 'bedrock-converse',
        apiProvider: 'bedrock',
        model: getModelForProvider(options, env, 'bedrock-converse'),
        adapterId: 'bedrock-converse',
        auth: { type: 'none' },
        authSource: 'aws-provider-chain',
        capabilities: createBedrockConverseCapabilities(),
        diagnostics: ['resolved explicit bedrock-converse provider'],
      }),
      options.requiredCapabilities,
    )
  }

  const apiProvider =
    explicitProfile?.apiProvider ?? options.apiProvider ?? getLegacyAPIProvider(env)
  if (apiProvider === 'openai') {
    if (env.OPENAI_API_KEY || options.authByProviderId?.['openai-responses']) {
      return resolveOpenAIResponses(options, env, 'openai-responses')
    }
    if (isOpenCodeGoEnabled(env) || options.authByProviderId?.['opencode-go']) {
      return resolveOpenCodeGo(options, env, 'opencode-go')
    }
    return resolveChatGptCodex(options, env, 'chatgpt-codex')
  }

  return resolveAnthropicCompatibleProvider(options, env, apiProvider)
}

function resolveOpenAIResponses(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): ProviderResolution {
  const auth = getOpenAIResponsesAuth(options, env)
  if (!auth) {
    return fail('missing_auth', {
      providerId,
      model: getModelForProvider(options, env, providerId),
      message: 'OpenAI Responses requires OPENAI_API_KEY or stored provider auth',
    })
  }

  const model = getModelForProvider(options, env, providerId)
  const capability = getKnownNonClaudeModelCapability(model, 'openai-responses')
  if (!capability) {
    return fail('unknown_model', {
      providerId,
      model,
      message: `Unknown OpenAI Responses model '${model}'`,
    })
  }

  return withCapabilityCheck(
    createRuntime({
      providerId,
      apiProvider: 'openai',
      model,
      adapterId: 'openai-responses',
      auth,
      authSource: env.OPENAI_API_KEY
        ? 'OPENAI_API_KEY'
        : 'provider-auth-store',
      capabilities: createOpenAIResponsesCapabilities(capability),
      baseUrl: env.OPENAI_BASE_URL,
      diagnostics: ['resolved OpenAI Responses provider'],
    }),
    options.requiredCapabilities,
  )
}

function resolveOpenCodeGo(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): ProviderResolution {
  const auth = getOpenCodeGoAuth(options, env)
  const model = getModelForProvider(options, env, providerId)
  if (!model) {
    return fail('unknown_model', {
      providerId,
      model,
      message:
        'OpenCode Go requires OPENCODE_MODEL, OPENCODE_GO_MODEL, FREE_CODE_OPENCODE_GO_MODEL, OPENAI_MODEL, or an explicit model override',
    })
  }
  if (!auth) {
    return fail('missing_auth', {
      providerId,
      model,
      message:
        'OpenCode Go requires OPENCODE_API_KEY, OPENCODE_GO_API_KEY, FREE_CODE_OPENCODE_GO_API_KEY, or stored provider auth',
    })
  }

  return withCapabilityCheck(
    createRuntime({
      providerId,
      apiProvider: 'openai',
      model,
      adapterId: 'opencode-go',
      auth,
      authSource: getOpenCodeGoApiKey(env)
        ? 'OPENCODE_API_KEY'
        : 'provider-auth-store',
      capabilities: createOpenAIChatCompletionsCapabilities(),
      baseUrl: getOpenCodeGoBaseUrl(env),
      diagnostics: ['resolved OpenCode Go provider'],
    }),
    options.requiredCapabilities,
  )
}

function resolveChatGptCodex(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): ProviderResolution {
  const auth = getChatGptCodexAuth(options)
  const model = getModelForProvider(options, env, providerId)
  if (!auth) {
    return fail('missing_auth', {
      providerId,
      model,
      message: 'ChatGPT Codex requires existing Codex OAuth tokens',
    })
  }

  const capability = getKnownNonClaudeModelCapability(model, 'chatgpt-codex')
  if (!capability) {
    return fail('unknown_model', {
      providerId,
      model,
      message: `Unknown ChatGPT Codex model '${model}'`,
    })
  }

  return withCapabilityCheck(
    createRuntime({
      providerId,
      apiProvider: 'openai',
      model,
      adapterId: 'chatgpt-codex',
      auth,
      authSource: options.codexOAuthTokens
        ? 'existing-codex-oauth'
        : 'provider-auth-store',
      capabilities: createChatGptCodexCapabilities(capability),
      diagnostics: [
        'resolved ChatGPT Codex provider',
        'Codex OAuth refresh remains owned by getFreshCodexOAuthTokens',
      ],
    }),
    options.requiredCapabilities,
  )
}

function resolveAnthropicCompatibleProvider(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  apiProvider: APIProvider,
): ProviderResolution {
  const model = getModelForProvider(
    options,
    env,
    getAnthropicProviderId(apiProvider),
  )
  const requiredAdapter = getRequiredNonClaudeAdapterForModel(apiProvider, model)

  if (requiredAdapter === 'bedrock-converse') {
    return withCapabilityCheck(
      createRuntime({
        providerId: 'bedrock-converse',
        apiProvider,
        model,
        adapterId: 'bedrock-converse',
        auth: { type: 'none' },
        authSource: 'aws-provider-chain',
        capabilities: createBedrockConverseCapabilities(),
        diagnostics: ['resolved Bedrock Converse provider'],
      }),
      options.requiredCapabilities,
    )
  }

  if (requiredAdapter) {
    return fail('not_implemented', {
      providerId: getAnthropicProviderId(apiProvider),
      model,
      adapterId: requiredAdapter,
      message: `Adapter '${requiredAdapter}' is not wired yet`,
    })
  }

  const providerId = getAnthropicProviderId(apiProvider)
  return withCapabilityCheck(
    createRuntime({
      providerId,
      apiProvider,
      model,
      adapterId: getAnthropicAdapterId(apiProvider),
      auth: getAnthropicAuth(options, env, providerId),
      authSource: getAnthropicAuthSource(options, env, providerId),
      capabilities: createAnthropicMessagesCapabilities(model),
      diagnostics: [`resolved ${providerId} provider`],
    }),
    options.requiredCapabilities,
  )
}

function getLegacyAPIProvider(env: ProviderResolverEnv): APIProvider {
  return isEnvTruthy(env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : isEnvTruthy(env.CLAUDE_CODE_USE_OPENAI) || isOpenCodeGoEnabled(env)
          ? 'openai'
          : 'firstParty'
}

function getModelForProvider(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): string {
  if (options.model?.trim()) return options.model.trim()
  if (providerId === 'opencode-go') return getOpenCodeGoModel(env)?.trim() || ''
  const profile = getProviderProfile(providerId)
  const envModelName = profile?.env.model
  const envModel = envModelName ? env[envModelName] : undefined
  return envModel?.trim() || profile?.defaultModel || 'claude-sonnet-4-6'
}

function getOpenAIResponsesAuth(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
): ProviderAuth | undefined {
  if (env.OPENAI_API_KEY) {
    return {
      type: 'api',
      key: env.OPENAI_API_KEY,
      header: 'Authorization',
      scheme: 'bearer',
    }
  }
  const stored = options.authByProviderId?.['openai-responses']
  return stored?.type === 'api' ? stored : undefined
}

function getOpenCodeGoAuth(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
): ProviderAuth | undefined {
  const apiKey = getOpenCodeGoApiKey(env)
  if (apiKey) {
    return {
      type: 'api',
      key: apiKey,
      header: 'Authorization',
      scheme: 'bearer',
    }
  }
  const stored = options.authByProviderId?.['opencode-go']
  return stored?.type === 'api' ? stored : undefined
}

function getChatGptCodexAuth(
  options: ResolveProviderRuntimeOptions,
): ProviderAuth | undefined {
  if (options.codexOAuthTokens?.accessToken) {
    return {
      type: 'oauth',
      access: options.codexOAuthTokens.accessToken,
      refresh: options.codexOAuthTokens.refreshToken ?? undefined,
      expires: options.codexOAuthTokens.expiresAt ?? undefined,
      accountId: options.codexOAuthTokens.accountId ?? undefined,
    }
  }
  const stored = options.authByProviderId?.['chatgpt-codex']
  return stored?.type === 'oauth' ? stored : undefined
}

function getAnthropicAuth(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): ProviderAuth {
  if (providerId === 'anthropic-direct' && env.ANTHROPIC_API_KEY) {
    return {
      type: 'api',
      key: env.ANTHROPIC_API_KEY,
      header: 'x-api-key',
      scheme: 'raw',
    }
  }
  const stored = options.authByProviderId?.[providerId]
  return stored ?? { type: 'none' }
}

function getAnthropicAuthSource(
  options: ResolveProviderRuntimeOptions,
  env: ProviderResolverEnv,
  providerId: ProviderId,
): string {
  if (providerId === 'anthropic-direct' && env.ANTHROPIC_API_KEY) {
    return 'ANTHROPIC_API_KEY'
  }
  if (options.authByProviderId?.[providerId]) {
    return 'provider-auth-store'
  }
  switch (providerId) {
    case 'anthropic-bedrock':
      return 'aws-provider-chain'
    case 'anthropic-vertex':
      return 'gcp-provider-chain'
    case 'anthropic-foundry':
      return 'azure-provider-chain'
    default:
      return 'existing-anthropic-auth'
  }
}

function getAnthropicProviderId(apiProvider: APIProvider): ProviderId {
  switch (apiProvider) {
    case 'bedrock':
      return 'anthropic-bedrock'
    case 'vertex':
      return 'anthropic-vertex'
    case 'foundry':
      return 'anthropic-foundry'
    case 'firstParty':
    case 'openai':
      return 'anthropic-direct'
  }
}

function getAnthropicAdapterId(apiProvider: APIProvider): ModelProviderAdapterId {
  switch (apiProvider) {
    case 'bedrock':
      return 'anthropic-bedrock'
    case 'vertex':
      return 'anthropic-vertex'
    case 'foundry':
      return 'anthropic-foundry'
    case 'firstParty':
    case 'openai':
      return 'anthropic-direct'
  }
}

function createRuntime(
  runtime: Omit<ResolvedModelRuntime, 'transport'>,
): ProviderResolution {
  if (!runtime.model.trim()) {
    return fail('unknown_model', {
      providerId: runtime.providerId,
      model: runtime.model,
      message: 'Model name cannot be empty',
    })
  }
  return {
    ok: true,
    runtime: {
      ...runtime,
      transport: runtime.capabilities.transport,
    },
  }
}

function withCapabilityCheck(
  resolution: ProviderResolution,
  requirements: ProviderCapabilityRequirement | undefined,
): ProviderResolution {
  if (!resolution.ok || !requirements) return resolution
  for (const [capability, required] of Object.entries(requirements) as Array<
    [keyof ProviderCapabilityRequirement, boolean | undefined]
  >) {
    if (required === true && resolution.runtime.capabilities[capability] !== true) {
      return fail('unsupported_capability', {
        providerId: resolution.runtime.providerId,
        model: resolution.runtime.model,
        adapterId: resolution.runtime.adapterId,
        capability,
        message: `Provider '${resolution.runtime.providerId}' does not support '${capability}'`,
      })
    }
  }
  return resolution
}

function fail(
  reason: ProviderResolution extends infer R
    ? R extends { ok: false; reason: infer Reason }
      ? Reason
      : never
    : never,
  details: Omit<Extract<ProviderResolution, { ok: false }>, 'ok' | 'reason'>,
): ProviderResolution {
  return { ok: false, reason, ...details }
}
