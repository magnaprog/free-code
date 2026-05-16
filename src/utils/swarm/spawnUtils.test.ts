import { afterEach, describe, expect, test } from 'bun:test'
import { readFile } from 'fs/promises'
import { buildInheritedEnvSetupCommand } from './spawnUtils.js'

const trackedEnv = ['CLAUDE_CODE_USE_OPENAI', 'OPENAI_API_KEY'] as const
const originalEnv = Object.fromEntries(
  trackedEnv.map(key => [key, process.env[key]]),
)

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('buildInheritedEnvSetupCommand', () => {
  test('keeps forwarded secrets out of the typed command string', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'sk-test-secret-for-spawn-utils'

    const setup = await buildInheritedEnvSetupCommand()
    try {
      expect(setup.command).not.toContain('sk-test-secret-for-spawn-utils')
      expect(setup.command).not.toContain('OPENAI_API_KEY=')

      const quotedPath = setup.command.match(/^\. ([^;]+);/)?.[1]
      expect(quotedPath).toBeDefined()
      const envFilePath = quotedPath!.replace(/^'(.+)'$/, '$1')
      const envFile = await readFile(envFilePath, 'utf8')
      expect(envFile).toContain('OPENAI_API_KEY')
      expect(envFile).toContain('sk-test-secret-for-spawn-utils')
    } finally {
      await setup.cleanup()
    }
  })
})
