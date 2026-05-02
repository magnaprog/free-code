import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ShellCommand } from '../ShellCommand.js'
import {
  getHookEnvFilePath,
  getSessionEnvironmentScript,
  invalidateSessionEnvCache,
} from '../sessionEnvironment.js'
import {
  checkForAsyncHookResponses,
  registerPendingAsyncHook,
} from './AsyncHookRegistry.js'

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

function createCompletedHookCommand(stdout: string): ShellCommand {
  return {
    background: () => false,
    result: Promise.resolve({
      stdout,
      stderr: '',
      code: 0,
      interrupted: false,
    }),
    kill: () => {},
    status: 'completed',
    cleanup: () => {},
    taskOutput: {
      getStdout: async () => stdout,
      getStderr: () => '',
    },
  } as ShellCommand
}

describe('async hook session environment cache', () => {
  test('Setup hook completion invalidates cached empty environment', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'free-code-async-hook-'))
    process.env.CLAUDE_CONFIG_DIR = join(tempDir, 'config')
    delete process.env.CLAUDE_ENV_FILE

    invalidateSessionEnvCache()
    expect(await getSessionEnvironmentScript()).toBeNull()

    await writeFile(
      await getHookEnvFilePath('Setup', 0),
      'export TEST_ENV=setup',
    )
    registerPendingAsyncHook({
      processId: 'async_setup_hook_test',
      hookId: 'setup-hook-test',
      asyncResponse: { async: true },
      hookName: 'Setup:init',
      hookEvent: 'Setup',
      command: 'setup hook',
      shellCommand: createCompletedHookCommand('{"async":true}\n'),
    })

    await checkForAsyncHookResponses()

    expect(await getSessionEnvironmentScript()).toBe('export TEST_ENV=setup')
  })
})
