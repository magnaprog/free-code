import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProviderAuthStore } from './authStore.js'
import {
  resolveProviderRuntime,
  resolveProviderRuntimeFromAuthStore,
  type ProviderResolverEnv,
} from './providerResolver.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'free-code-provider-'))
  tempDirs.push(dir)
  return dir
}

describe('provider resolver', () => {
  test('resolves default Anthropic runtime without env mutation', () => {
    const env: ProviderResolverEnv = {
      ANTHROPIC_API_KEY: 'fake-anthropic-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
    }
    const beforeEnv = { ...env }

    const resolution = resolveProviderRuntime({ env })

    expect(env).toEqual(beforeEnv)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('anthropic-direct')
    expect(resolution.runtime.transport).toBe('anthropic_messages')
    expect(resolution.runtime.auth.type).toBe('api')
    expect(resolution.runtime.authSource).toBe('ANTHROPIC_API_KEY')
  })

  test('OPENAI_API_KEY wins over Codex OAuth tokens', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_API_KEY: 'fake-openai-key',
        OPENAI_MODEL: 'gpt-5.5',
      },
      codexOAuthTokens: {
        accessToken: 'fake-codex-token',
        accountId: 'fake-account',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('openai-responses')
    expect(resolution.runtime.transport).toBe('openai_responses')
    expect(resolution.runtime.adapterId).toBe('openai-responses')
    expect(resolution.runtime.auth.type).toBe('api')
  })

  test('resolves mocked ChatGPT Codex OAuth without taking refresh ownership', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_MODEL: 'gpt-5.5',
      },
      codexOAuthTokens: {
        accessToken: 'fake-codex-token',
        refreshToken: 'fake-refresh-token',
        expiresAt: 1_900_000_000_000,
        accountId: 'fake-account',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('chatgpt-codex')
    expect(resolution.runtime.transport).toBe('chatgpt_codex')
    expect(resolution.runtime.auth.type).toBe('oauth')
    expect(resolution.runtime.diagnostics).toContain(
      'Codex OAuth refresh remains owned by getFreshCodexOAuthTokens',
    )
  })

  test('preserves Bedrock Claude and non-Claude routing distinction', () => {
    const claude = resolveProviderRuntime({
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
    })
    const converse = resolveProviderRuntime({
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
      model: 'amazon.nova-pro-v1:0',
    })

    expect(claude.ok).toBe(true)
    if (!claude.ok) throw new Error(claude.message)
    expect(claude.runtime.providerId).toBe('anthropic-bedrock')
    expect(claude.runtime.transport).toBe('anthropic_messages')

    expect(converse.ok).toBe(true)
    if (!converse.ok) throw new Error(converse.message)
    expect(converse.runtime.providerId).toBe('bedrock-converse')
    expect(converse.runtime.transport).toBe('bedrock_converse')
  })

  test('resolves OpenCode Go with env aliases and verified default base URL', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENCODE_GO: '1',
        OPENCODE_API_KEY: 'fake-opencode-key',
        OPENCODE_MODEL: 'opencode-go/qwen-test',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('opencode-go')
    expect(resolution.runtime.transport).toBe('openai_chat_completions')
    expect(resolution.runtime.adapterId).toBe('opencode-go')
    expect(resolution.runtime.auth.type).toBe('api')
    expect(resolution.runtime.baseUrl).toBe('https://opencode.ai/zen/v1')
  })

  // B5: explicit OpenCode Zen flag wins over a lingering OPENAI_API_KEY.
  // The previous behavior ("OpenAI key wins") was silently surprising —
  // an unrelated env var in the shell shadowed an explicit provider
  // selection. Resolver and client.ts now agree on this precedence.
  test('explicit OpenCode flag wins over lingering OPENAI_API_KEY', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENCODE_GO: '1',
        OPENCODE_API_KEY: 'fake-opencode-key',
        OPENCODE_MODEL: 'opencode-go/qwen-test',
        OPENAI_API_KEY: 'fake-openai-key',
        OPENAI_MODEL: 'gpt-5.5',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('opencode-go')
    expect(resolution.runtime.transport).toBe('openai_chat_completions')
  })

  // B14: per-model transport routing. Claude models route to anthropic_messages.
  test('OpenCode with claude-* model resolves to anthropic_messages transport', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENCODE_GO: '1',
        OPENCODE_API_KEY: 'fake-opencode-key',
        OPENCODE_MODEL: 'claude-sonnet-4-6',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('opencode-go')
    expect(resolution.runtime.transport).toBe('anthropic_messages')
  })

  // B14: GPT models route to openai_responses transport.
  test('OpenCode with gpt-* model resolves to openai_responses transport', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENCODE_GO: '1',
        OPENCODE_API_KEY: 'fake-opencode-key',
        OPENCODE_MODEL: 'gpt-5.5',
      },
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('opencode-go')
    expect(resolution.runtime.transport).toBe('openai_responses')
  })

  // B14: Gemini models fail closed until /models/{id} adapter is wired.
  test('OpenCode with gemini-* model fails closed as not_implemented', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENCODE_GO: '1',
        OPENCODE_API_KEY: 'fake-opencode-key',
        OPENCODE_MODEL: 'gemini-3.1-pro',
      },
    })

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error('expected fail-closed for gemini')
    expect(resolution.reason).toBe('not_implemented')
    expect(resolution.message).toContain('gemini')
  })

  test('OpenCode Go fails clearly without model or auth', () => {
    const missingModel = resolveProviderRuntime({
      providerId: 'opencode-go',
      env: { OPENCODE_API_KEY: 'fake-opencode-key' },
    })
    const missingAuth = resolveProviderRuntime({
      providerId: 'opencode-go',
      env: { OPENCODE_MODEL: 'opencode-go/qwen-test' },
    })

    expect(missingModel).toMatchObject({
      ok: false,
      reason: 'unknown_model',
      providerId: 'opencode-go',
    })
    expect(missingAuth).toMatchObject({
      ok: false,
      reason: 'missing_auth',
      providerId: 'opencode-go',
    })
  })

  test('fails closed for unwired Vertex Gemini and Foundry inference adapters', () => {
    const vertex = resolveProviderRuntime({
      env: { CLAUDE_CODE_USE_VERTEX: '1' },
      model: 'gemini-2.5-pro',
    })
    const foundry = resolveProviderRuntime({
      env: { CLAUDE_CODE_USE_FOUNDRY: '1' },
      model: 'gpt-5.5',
    })

    expect(vertex).toMatchObject({
      ok: false,
      reason: 'not_implemented',
      adapterId: 'vertex-gemini',
    })
    expect(foundry).toMatchObject({
      ok: false,
      reason: 'not_implemented',
      adapterId: 'azure-foundry-inference',
    })
  })

  test('fails closed for unknown providers', () => {
    const resolution = resolveProviderRuntime({
      providerId: 'made-up-provider',
      model: 'test-model',
      env: {},
    })

    expect(resolution).toMatchObject({
      ok: false,
      reason: 'unknown_provider',
      providerId: 'made-up-provider',
    })
  })

  test('resolves from a temp auth store and writes POSIX 0600 auth files', async () => {
    const dir = await makeTempDir()
    const authPath = join(dir, 'auth.json')
    const authStore = new ProviderAuthStore({ path: authPath })
    await authStore.setProviderAuth('openai-responses', {
      type: 'api',
      key: 'fake-stored-openai-key',
      header: 'Authorization',
      scheme: 'bearer',
    })

    if (process.platform !== 'win32') {
      expect((await stat(authPath)).mode & 0o777).toBe(0o600)
    }

    const resolution = await resolveProviderRuntimeFromAuthStore({
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_MODEL: 'gpt-5.5',
      },
      authStore,
    })

    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.message)
    expect(resolution.runtime.providerId).toBe('openai-responses')
    expect(resolution.runtime.authSource).toBe('provider-auth-store')
  })

  test('reports unsupported requested capabilities instead of assuming support', () => {
    const resolution = resolveProviderRuntime({
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_MODEL: 'gpt-5.5',
      },
      codexOAuthTokens: { accessToken: 'fake-codex-token' },
      requiredCapabilities: { supportsPromptCaching: true },
    })

    expect(resolution).toMatchObject({
      ok: false,
      reason: 'unsupported_capability',
      providerId: 'chatgpt-codex',
      capability: 'supportsPromptCaching',
    })
  })

  test('does not mutate process.env when using ambient env', () => {
    const keys = [
      'CLAUDE_CODE_USE_OPENAI',
      'OPENAI_API_KEY',
      'OPENAI_MODEL',
    ] as const
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))

    try {
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      process.env.OPENAI_API_KEY = 'fake-openai-key'
      process.env.OPENAI_MODEL = 'gpt-5.5'
      const before = Object.fromEntries(keys.map(key => [key, process.env[key]]))

      const resolution = resolveProviderRuntime()

      expect(Object.fromEntries(keys.map(key => [key, process.env[key]]))).toEqual(
        before,
      )
      expect(resolution.ok).toBe(true)
      if (!resolution.ok) throw new Error(resolution.message)
      expect(resolution.runtime.providerId).toBe('openai-responses')
    } finally {
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
