import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

mock.module('./hooks/hooksConfigSnapshot.js', () => ({
  captureHooksConfigSnapshot: () => {},
  getHooksConfigFromSnapshot: () => ({}),
  resetHooksConfigSnapshot: () => {},
  shouldAllowManagedHooksOnly: () => true,
  shouldDisableAllHooksIncludingManaged: () => false,
  updateHooksConfigSnapshot: () => {},
}))

const { getSessionEnvironmentScript, invalidateSessionEnvCache } = await import(
  './sessionEnvironment.js'
)
const { processSessionStartHooks, processSetupHooks } = await import(
  './sessionStart.js'
)

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalClaudeEnvFile = process.env.CLAUDE_ENV_FILE
let tempDir: string | undefined

afterEach(async () => {
  invalidateSessionEnvCache()

  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (originalClaudeEnvFile === undefined) {
    delete process.env.CLAUDE_ENV_FILE
  } else {
    process.env.CLAUDE_ENV_FILE = originalClaudeEnvFile
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

async function seedCachedEnvScript(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'free-code-session-start-'))
  process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')

  const envFile = join(tempDir, 'env.sh')
  process.env.CLAUDE_ENV_FILE = envFile

  invalidateSessionEnvCache()
  await writeFile(envFile, 'export TEST_ENV=old')
  expect(await getSessionEnvironmentScript()).toBe('export TEST_ENV=old')

  await writeFile(envFile, 'export TEST_ENV=new')
}

describe('startup hook environment cache', () => {
  test('SessionStart processing invalidates cached environment scripts', async () => {
    await seedCachedEnvScript()

    await processSessionStartHooks('compact', { forceSyncExecution: true })

    expect(await getSessionEnvironmentScript()).toBe('export TEST_ENV=new')
  })

  test('Setup processing invalidates cached environment scripts', async () => {
    await seedCachedEnvScript()

    await processSetupHooks('init', { forceSyncExecution: true })

    expect(await getSessionEnvironmentScript()).toBe('export TEST_ENV=new')
  })
})
