/**
 * Branch-wiring regression tests for getAnthropicClient(). Each
 * non-direct provider branch is required to spread one of the
 * suppression constants (NON_DIRECT_ENV_AUTH_SUPPRESSION or
 * NON_DIRECT_ENV_BEARER_SUPPRESSION) so the underlying SDK does
 * not fall back to ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN env
 * defaults. The helper-constants test (clientAuthHeaders.test.ts)
 * pins the constants themselves; this file pins that each branch
 * actually applies them at runtime.
 *
 * Approach: mock each SDK class to capture constructor args + mock
 * the heaviest external deps (Azure/Google auth, fetch adapters)
 * but leave auth.ts and providerCapabilities.ts un-mocked. Real
 * auth functions work without OAuth token files as long as
 * ANTHROPIC_API_KEY is set; real providerCapabilities maps model
 * names to adapter ids correctly.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type CapturedConstructor = {
  name: string
  args: Record<string, unknown>
}

const captured: CapturedConstructor[] = []

function recordCapture(name: string) {
  return class {
    constructor(args: Record<string, unknown>) {
      captured.push({ name, args })
    }
    // The Bedrock branch assigns these after construction; declared so the
    // stub instance accepts the writes without TS complaining.
    awsAccessKey: unknown
    awsSecretKey: unknown
    awsSessionToken: unknown
    awsRegion: unknown
    skipAuth: unknown
    defaultHeaders: unknown
  }
}

const stubAnthropic = recordCapture('Anthropic')

// Enumerate every SDK error class downstream code imports. Bun's
// mock.module replaces the module at import-resolution time and
// reads its exports statically, so a Proxy-based dynamic stub
// cannot satisfy named imports. If the SDK ever adds a new error
// class that the rest of the codebase imports, the test will fail
// fast with a clear "Export named 'Foo' not found" message — easier
// to debug than a Proxy that silently returns the wrong shape.
const ErrorClass = (): typeof Error => class extends Error {}
mock.module('@anthropic-ai/sdk', () => ({
  default: stubAnthropic,
  Anthropic: stubAnthropic,
  APIError: ErrorClass(),
  APIUserAbortError: ErrorClass(),
  APIConnectionError: ErrorClass(),
  APIConnectionTimeoutError: ErrorClass(),
  AuthenticationError: ErrorClass(),
  PermissionDeniedError: ErrorClass(),
  NotFoundError: ErrorClass(),
  ConflictError: ErrorClass(),
  UnprocessableEntityError: ErrorClass(),
  RateLimitError: ErrorClass(),
  BadRequestError: ErrorClass(),
  InternalServerError: ErrorClass(),
  AnthropicError: ErrorClass(),
}))
mock.module('@anthropic-ai/bedrock-sdk', () => ({
  AnthropicBedrock: recordCapture('AnthropicBedrock'),
}))
mock.module('@anthropic-ai/foundry-sdk', () => ({
  AnthropicFoundry: recordCapture('AnthropicFoundry'),
}))
mock.module('@anthropic-ai/vertex-sdk', () => ({
  AnthropicVertex: recordCapture('AnthropicVertex'),
}))
mock.module('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(_: unknown) {}
    async getClient() {
      return {}
    }
  },
}))
mock.module('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  getBearerTokenProvider: () => async () => 'azure-test-token',
}))

// Fetch adapters are factory functions; they return a wrapped fetch but
// don't invoke it at construction time. Use real adapters so leaking
// module mocks don't poison other test files in the same run.

// Import after mocks are registered.
const { getAnthropicClient } = await import('./client.js')

const trackedEnv = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_OPENCODE_GO',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'AWS_BEARER_TOKEN_BEDROCK',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'ANTHROPIC_API_KEY',
] as const

const originalEnv = Object.fromEntries(
  trackedEnv.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  captured.length = 0
  for (const key of trackedEnv) delete process.env[key]
  // Direct path needs an auth source so isAnthropicAuthEnabled() doesn't
  // throw when called transitively from configureApiKeyHeaders / model
  // resolution. Tests do not hit a real API.
  process.env.ANTHROPIC_API_KEY = 'sk-test-direct'
})

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(() => {
  mock.restore()
})

describe('provider branch-wiring — auth suppression', () => {
  test('Bedrock SDK branch passes apiKey:null and authToken:null', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-test-token'
    await getAnthropicClient({
      maxRetries: 0,
      model: 'anthropic.claude-3-5-sonnet-20240620-v1:0',
    })
    const last = captured.pop()
    expect(last?.name).toBe('AnthropicBedrock')
    expect(last?.args.apiKey).toBeNull()
    expect(last?.args.authToken).toBeNull()
  })

  test('Bedrock Converse branch passes authToken:null + placeholder apiKey', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    // Model not matching anthropic.claude/claude- routes to bedrock-converse.
    await getAnthropicClient({ maxRetries: 0, model: 'us.amazon.nova-pro-v1:0' })
    const last = captured.pop()
    expect(last?.name).toBe('Anthropic')
    expect(last?.args.apiKey).toBe('bedrock-converse-placeholder')
    expect(last?.args.authToken).toBeNull()
  })

  test('Vertex branch passes apiKey:null and authToken:null', async () => {
    process.env.CLAUDE_CODE_USE_VERTEX = '1'
    process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1'
    process.env.CLOUD_ML_REGION = 'us-east5'
    process.env.ANTHROPIC_VERTEX_PROJECT_ID = 'test-project'
    await getAnthropicClient({
      maxRetries: 0,
      model: 'claude-3-5-sonnet-v2@20241022',
    })
    const last = captured.pop()
    expect(last?.name).toBe('AnthropicVertex')
    expect(last?.args.apiKey).toBeNull()
    expect(last?.args.authToken).toBeNull()
  })

  test('Foundry skip-auth branch passes authToken:null + placeholder apiKey + fetch wrapper', async () => {
    process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
    process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH = '1'
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'test-resource'
    await getAnthropicClient({
      maxRetries: 0,
      model: 'claude-3-5-sonnet-20240620',
    })
    const last = captured.pop()
    expect(last?.name).toBe('AnthropicFoundry')
    expect(last?.args.apiKey).toBe('foundry-skip-auth-placeholder')
    expect(last?.args.authToken).toBeNull()
    expect(typeof last?.args.fetch).toBe('function')
  })

  test('OpenCode openai_responses branch passes authToken:null + placeholder apiKey', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'
    await getAnthropicClient({ maxRetries: 0, model: 'gpt-4o-mini' })
    const last = captured.pop()
    expect(last?.name).toBe('Anthropic')
    expect(last?.args.apiKey).toBe('opencode-zen-placeholder')
    expect(last?.args.authToken).toBeNull()
  })

  test('OpenCode chat-completions branch passes authToken:null + placeholder apiKey', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-test-key'
    await getAnthropicClient({
      maxRetries: 0,
      model: 'qwen2.5-coder-32b-instruct',
    })
    const last = captured.pop()
    expect(last?.name).toBe('Anthropic')
    expect(last?.args.apiKey).toBe('opencode-zen-placeholder')
    expect(last?.args.authToken).toBeNull()
  })

  test('OpenCode anthropic_messages branch passes provider apiKey + authToken', async () => {
    // This branch is an exception: OpenCode owns both Anthropic-shaped auth
    // forms, so apiKey and authToken are set to the OpenCode key (not to
    // null via the suppression constants). Verify the explicit override
    // still wins over any inherited SDK env defaults.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_USE_OPENCODE_GO = '1'
    process.env.OPENCODE_API_KEY = 'opencode-anthropic-key'
    await getAnthropicClient({
      maxRetries: 0,
      model: 'claude-sonnet-4-5-20250929',
    })
    const last = captured.pop()
    expect(last?.name).toBe('Anthropic')
    expect(last?.args.apiKey).toBe('opencode-anthropic-key')
    expect(last?.args.authToken).toBe('opencode-anthropic-key')
  })

  test('OpenAI direct branch passes authToken:null + placeholder apiKey', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-openai-test'
    await getAnthropicClient({ maxRetries: 0, model: 'gpt-4o-mini' })
    const last = captured.pop()
    expect(last?.name).toBe('Anthropic')
    expect(last?.args.apiKey).toBe('openai-placeholder')
    expect(last?.args.authToken).toBeNull()
  })
})
