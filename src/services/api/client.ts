import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { isAttributionHeaderEnabled } from 'src/constants/system.js'
import {
  computeCch,
  hasCchPlaceholder,
  replaceCchPlaceholder,
} from 'src/utils/cch.js'
import type { GoogleAuth } from 'google-auth-library'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  getFreshCodexOAuthTokens,
  isClaudeAISubscriber,
  isCodexSubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'
import {
  createCodexFetch,
  createOpenAIResponsesFetch,
} from './codex-fetch-adapter.js'
import { createBedrockConverseFetch } from './bedrock-converse-fetch-adapter.js'
import { createOpenAIChatCompletionsFetch } from './openai-chat-completions-fetch-adapter.js'
import { getRequiredNonClaudeAdapterForModel } from '../../utils/model/providerCapabilities.js'
import {
  getOpenCodeAnthropicBaseUrl,
  getOpenCodeGoApiKey,
  getOpenCodeGoBaseUrl,
  getOpenCodeGoModel,
  getOpenCodeTransportForModel,
  isOpenCodeGoEnabled,
  normalizeOpenCodeGoModel,
} from '../provider/openCodeGo.js'

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - ANTHROPIC_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5: Region for Claude Haiku 4.5 model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  const defaultHeaders: { [key: string]: string } = {
    ...(isAttributionHeaderEnabled()
      ? {
          'x-app': 'cli',
          'User-Agent': getUserAgent(),
          'X-Claude-Code-Session-Id': getSessionId(),
          ...(containerId
            ? { 'x-claude-remote-container-id': containerId }
            : {}),
          ...(remoteSessionId
            ? { 'x-claude-remote-session-id': remoteSessionId }
            : {}),
          // SDK consumers can identify their app/library for backend analytics
          ...(clientApp ? { 'x-client-app': clientApp } : {}),
        }
      : {}),
    ...customHeaders,
  }

  // Log API client configuration for HFI debugging
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // Add additional protection header if enabled via env var
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  if (!isClaudeAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  // Common args shared by every client construction. The fetchOptions
  // here intentionally does NOT request the Anthropic-only unix-socket
  // routing — only the direct first-party Anthropic client should opt
  // in to that path via `firstPartyAnthropicArgs` below.
  const COMMON_ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }

  // ARGS for the direct first-party Anthropic API client.
  // ANTHROPIC_UNIX_SOCKET tunneling is scoped to actual api.anthropic.com
  // requests: the unix-socket auth proxy hard-codes upstream to the
  // Anthropic API. If a user has overridden ANTHROPIC_BASE_URL to point
  // at a custom gateway, opting into the unix socket would misroute the
  // request to the auth proxy. Gate the flag by the actual base URL.
  const ARGS = {
    ...COMMON_ARGS,
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: isFirstPartyAnthropicBaseUrl(),
    }) as ClientOptions['fetchOptions'],
  }

  // ARGS for non-direct providers (Bedrock, Vertex, Foundry, OpenCode,
  // OpenAI Responses, ChatGPT Codex). Two boundary protections:
  //   1. No `forAnthropicAPI` → unix-socket scoped out.
  //   2. Sanitized defaultHeaders → Anthropic-side credentials
  //      (`Authorization`, `X-Api-Key`) from configureApiKeyHeaders or
  //      ANTHROPIC_CUSTOM_HEADERS cannot leak into non-direct provider
  //      requests via SDK right-merge.
  // Provider branches that need their own credentials re-add them
  // explicitly after spreading NON_DIRECT_ARGS.
  const NON_DIRECT_ARGS = {
    ...COMMON_ARGS,
    defaultHeaders: stripInheritedAuthHeaders(defaultHeaders),
    fetchOptions: getProxyFetchOptions() as ClientOptions['fetchOptions'],
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    if (
      model &&
      getRequiredNonClaudeAdapterForModel('bedrock', model) ===
        'bedrock-converse'
    ) {
      const bedrockConverseFetch = createBedrockConverseFetch()
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: 'bedrock-converse-placeholder',
        ...NON_DIRECT_ARGS,
        fetch: bedrockConverseFetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }
      return new Anthropic(clientConfig)
    }

    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    // Use region override for small fast model if specified
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    const bedrockArgs: ConstructorParameters<typeof AnthropicBedrock>[0] = {
      ...NON_DIRECT_ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true,
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // Add API key authentication if available
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // Add the Bearer token for Bedrock API key authentication
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
    } else if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      // Refresh auth and get credentials with cache clearing
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    // Determine Azure AD token provider based on configuration
    // SDK reads ANTHROPIC_FOUNDRY_API_KEY by default
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
        // Mock token provider for testing/proxy scenarios (similar to Vertex mock GoogleAuth)
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // Use real Azure AD authentication with DefaultAzureCredential
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof AnthropicFoundry>[0] = {
      ...NON_DIRECT_ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // Refresh GCP credentials if gcpAuthRefresh is configured and credentials are expired
    // This is similar to how we handle AWS credential refresh for Bedrock
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    // TODO: Cache either GoogleAuth instance or AuthClient to improve performance
    // Currently we create a new GoogleAuth instance for every getAnthropicClient() call
    // This could cause repeated authentication flows and metadata server checks
    // However, caching needs careful handling of:
    // - Credential refresh/expiration
    // - Environment variable changes (GOOGLE_APPLICATION_CREDENTIALS, project vars)
    // - Cross-request auth state management
    // See: https://github.com/googleapis/google-auth-library-nodejs/issues/390 for caching challenges

    // Prevent metadata server timeout by providing projectId as fallback
    // google-auth-library checks project ID in this order:
    // 1. Environment variables (GCLOUD_PROJECT, GOOGLE_CLOUD_PROJECT, etc.)
    // 2. Credential files (service account JSON, ADC file)
    // 3. gcloud config
    // 4. GCE metadata server (causes 12s timeout outside GCP)
    //
    // We only set projectId if user hasn't configured other discovery methods
    // to avoid interfering with their existing auth setup

    // Check project environment variables in same order as google-auth-library
    // See: https://github.com/googleapis/google-auth-library-nodejs/blob/main/src/auth/googleauth.ts
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // Check for credential file paths (service account or ADC)
    // Note: We're checking both standard and lowercase variants to be safe,
    // though we should verify what google-auth-library actually checks
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
      ? ({
          // Mock GoogleAuth for testing/proxy scenarios
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // Only use ANTHROPIC_VERTEX_PROJECT_ID as last resort fallback
          // This prevents the 12-second metadata server timeout when:
          // - No project env vars are set AND
          // - No credential keyfile is specified AND
          // - ADC file exists but lacks project_id field
          //
          // Risk: If auth project != API target project, this could cause billing/audit issues
          // Mitigation: Users can set GOOGLE_CLOUD_PROJECT to override
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
              }),
        })

    const vertexArgs: ConstructorParameters<typeof AnthropicVertex>[0] = {
      ...NON_DIRECT_ARGS,
      region: getVertexRegionForModel(model),
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // we have always been lying about the return type - this doesn't support batching or models
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }

  // B5: explicit OpenCode Zen flag wins over OpenAI key. Previously a
  // lingering `OPENAI_API_KEY` in the shell silently shadowed the explicit
  // `CLAUDE_CODE_USE_OPENCODE_GO=1` selection because the OpenAI Responses
  // branch was evaluated first. Reordered: OpenCode is checked first when
  // its flag is set.
  //
  // B14: per-model transport routing. OpenCode Zen routes Claude → /messages,
  // GPT → /responses, Gemini → /models/{id}, others → /chat/completions.
  // The previous single-adapter implementation forced everything through
  // /chat/completions, sending Claude/GPT/Gemini requests to the wrong
  // endpoint.
  if (getAPIProvider() === 'openai' && isOpenCodeGoEnabled()) {
    const openCodeGoApiKey = getOpenCodeGoApiKey()
    if (!openCodeGoApiKey) {
      throw new Error(
        'OpenCode Zen requires OPENCODE_API_KEY, OPENCODE_GO_API_KEY, or FREE_CODE_OPENCODE_GO_API_KEY',
      )
    }
    const configuredModel = model || getOpenCodeGoModel()
    const effectiveModel = configuredModel
      ? normalizeOpenCodeGoModel(configuredModel)
      : undefined
    if (!effectiveModel) {
      throw new Error(
        'OpenCode Zen requires OPENCODE_MODEL, OPENCODE_GO_MODEL, FREE_CODE_OPENCODE_GO_MODEL, or OPENAI_MODEL',
      )
    }
    const transport = getOpenCodeTransportForModel(effectiveModel)

    if (transport === 'gemini_native') {
      throw new Error(
        `OpenCode Zen gemini-* models route to /models/{id} which is not yet supported. ` +
          `Use a chat-completions model (qwen/kimi/glm/minimax/deepseek), Claude model, or GPT model instead.`,
      )
    }

    if (transport === 'anthropic_messages') {
      // Claude through OpenCode → /v1/messages. Anthropic SDK appends
      // /v1/messages itself, so strip the trailing /v1 from the canonical
      // OpenCode base URL.
      //
      // Header-merge gotcha: the SDK applies defaultHeaders AFTER
      // authHeaders (see @anthropic-ai/sdk/src/client.ts:984-985), so a
      // stray `Authorization` or `x-api-key` populated by
      // configureApiKeyHeaders, the api-key helper, or
      // ANTHROPIC_CUSTOM_HEADERS would override the SDK's headers
      // derived from apiKey/authToken and leak an Anthropic credential
      // to the OpenCode gateway. Round 8: strip any inherited auth
      // headers case-insensitively, then explicitly pin BOTH the Bearer
      // (per OpenCode docs) and X-Api-Key (Anthropic Messages
      // convention) to the OpenCode key.
      // Round 9: ARGS was built with `getProxyFetchOptions({ forAnthropicAPI:
      // true })`, which intentionally routes through ANTHROPIC_UNIX_SOCKET when
      // set (claude ssh auth proxy). Inheriting that here would misroute
      // OpenCode requests to the Anthropic-only socket regardless of
      // baseURL. Override fetchOptions to the non-Anthropic variant so
      // OpenCode talks directly to its own gateway over the regular
      // proxy/TLS configuration.
      const anthropicBaseUrl = getOpenCodeAnthropicBaseUrl()
      // NON_DIRECT_ARGS.defaultHeaders has already had Authorization
      // and X-Api-Key stripped (see stripInheritedAuthHeaders). Add
      // the OpenCode credentials explicitly so SDK right-merge can't
      // be overridden by a future caller adding stray Anthropic
      // headers to defaultHeaders.
      const argsForOpenCode = {
        ...NON_DIRECT_ARGS,
        defaultHeaders: {
          ...NON_DIRECT_ARGS.defaultHeaders,
          Authorization: `Bearer ${openCodeGoApiKey}`,
          'X-Api-Key': openCodeGoApiKey,
        },
      }
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: openCodeGoApiKey,
        authToken: openCodeGoApiKey,
        baseURL: anthropicBaseUrl,
        ...argsForOpenCode,
        fetch: createAnthropicModelMappingFetch(
          resolvedFetch,
          normalizeOpenCodeGoModel,
        ),
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }
      return new Anthropic(clientConfig)
    }

    if (transport === 'openai_responses') {
      // GPT through OpenCode → /responses.
      const openAIFetch = createOpenAIResponsesFetch(
        openCodeGoApiKey,
        getOpenCodeGoBaseUrl(),
        { mapModel: normalizeOpenCodeGoModel },
      )
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: 'opencode-zen-placeholder',
        ...NON_DIRECT_ARGS,
        fetch: openAIFetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }
      return new Anthropic(clientConfig)
    }

    // Default: openai_chat_completions for qwen/kimi/glm/minimax/deepseek.
    const openCodeGoFetch = createOpenAIChatCompletionsFetch(openCodeGoApiKey, {
      baseUrl: getOpenCodeGoBaseUrl(),
      authHeader: 'Authorization',
      authScheme: 'bearer',
    })
    const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: 'opencode-zen-placeholder',
      ...NON_DIRECT_ARGS,
      fetch: openCodeGoFetch as unknown as typeof globalThis.fetch,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    return new Anthropic(clientConfig)
  }

  // Prefer explicit OpenAI API keys over ChatGPT Codex OAuth when both exist.
  if (getAPIProvider() === 'openai' && process.env.OPENAI_API_KEY) {
    const openAIFetch = createOpenAIResponsesFetch(process.env.OPENAI_API_KEY)
    const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
      apiKey: 'openai-placeholder',
      ...NON_DIRECT_ARGS,
      fetch: openAIFetch as unknown as typeof globalThis.fetch,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    return new Anthropic(clientConfig)
  }

  // ── Codex (OpenAI) provider via fetch adapter ─────────────────────
  if (isCodexSubscriber()) {
    const codexTokens = await getFreshCodexOAuthTokens()
    if (codexTokens?.accessToken) {
      const codexFetch = createCodexFetch(codexTokens.accessToken)
      const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
        apiKey: 'codex-placeholder', // SDK requires a key but the fetch adapter handles auth
        ...NON_DIRECT_ARGS,
        fetch: codexFetch as unknown as typeof globalThis.fetch,
        ...(isDebugToStdErr() && { logger: createStderrLogger() }),
      }
      return new Anthropic(clientConfig)
    }
  }

  // Determine authentication method based on available tokens
  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken
      : undefined,
    // Set baseURL from OAuth config when using staging OAuth
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

/**
 * Round 8: when routing to a non-Anthropic backend that needs its own
 * credentials (currently OpenCode Zen), inherited defaultHeaders may
 * carry `Authorization` or `x-api-key` set by `configureApiKeyHeaders`,
 * the api-key helper, or `ANTHROPIC_CUSTOM_HEADERS`. Spreading those
 * into the backend's client config would either leak the Anthropic
 * credential to the gateway or get the wrong key picked up by SDK
 * header dedup. Strip them case-insensitively before re-pinning the
 * backend's own credentials.
 */
export function stripInheritedAuthHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|x-api-key)$/i.test(key)) continue
    out[key] = value
  }
  return out
}

function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // Split by newlines to support multiple headers
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // Parse header in format "Name: Value" (curl style). Split on first `:`
    // then trim — avoids regex backtracking on malformed long header lines.
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

function createAnthropicModelMappingFetch(
  inner: NonNullable<ClientOptions['fetch']>,
  mapModel: (model: string) => string,
): ClientOptions['fetch'] {
  return async (input, init) => {
    let body = init?.body
    if (typeof body === 'string') {
      try {
        const url = input instanceof Request ? input.url : String(input)
        const parsed = JSON.parse(body) as { model?: unknown }
        if (url.includes('/v1/messages') && typeof parsed.model === 'string') {
          body = JSON.stringify({ ...parsed, model: mapModel(parsed.model) })
        }
      } catch {
        // leave malformed/non-JSON bodies untouched
      }
    }
    return inner(input, { ...init, body })
  }
}

function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): NonNullable<ClientOptions['fetch']> {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // Only send in explicit upstream attribution mode. Bedrock/Vertex/Foundry
  // don't log it and unknown headers risk rejection by strict proxies.
  const injectClientRequestId =
    isAttributionHeaderEnabled() &&
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl()
  return async (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }

    let body = init?.body
    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )

      if (
        isAttributionHeaderEnabled() &&
        url.includes('/v1/messages') &&
        headers.has('anthropic-version') &&
        typeof body === 'string' &&
        hasCchPlaceholder(body)
      ) {
        const cch = await computeCch(body)
        body = replaceCchPlaceholder(body, cch)
        logForDebugging(`[CCH] signed request cch=${cch}`)
      }
    } catch {
      // never let logging crash the fetch
    }
    return inner(input, { ...init, headers, body })
  }
}
