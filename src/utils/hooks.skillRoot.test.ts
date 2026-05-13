import { afterEach, describe, expect, mock, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionId, setIsInteractive } from '../bootstrap/state.js'
import type { AppState } from '../state/AppState.js'

mock.module('./hooks/hooksConfigSnapshot.js', () => ({
  captureHooksConfigSnapshot: () => {},
  getHooksConfigFromSnapshot: () => ({}),
  resetHooksConfigSnapshot: () => {},
  shouldAllowManagedHooksOnly: () => false,
  shouldDisableAllHooksIncludingManaged: () => false,
  updateHooksConfigSnapshot: () => {},
}))

const { executeSessionEndHooks } = await import('./hooks.js')

const originalHookOutput = process.env.TEST_HOOK_OUTPUT
let tempDir: string | undefined

afterEach(async () => {
  setIsInteractive(true)
  if (originalHookOutput === undefined) {
    delete process.env.TEST_HOOK_OUTPUT
  } else {
    process.env.TEST_HOOK_OUTPUT = originalHookOutput
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

async function createSkillHookScript(): Promise<{
  skillRoot: string
  outputPath: string
}> {
  tempDir = await mkdtemp(join(tmpdir(), 'free-code-skill-hook-'))
  const skillRoot = join(tempDir, 'skill')
  await mkdir(skillRoot)

  const outputPath = join(tempDir, 'hook-output')
  process.env.TEST_HOOK_OUTPUT = outputPath

  const scriptPath = join(skillRoot, 'hook.sh')
  await writeFile(
    scriptPath,
    '#!/usr/bin/env bash\ncat >/dev/null\nprintf "%s|%s" "$CLAUDE_PLUGIN_ROOT" "$1" > "$TEST_HOOK_OUTPUT"\n',
  )
  await chmod(scriptPath, 0o755)

  return { skillRoot, outputPath }
}

function createSessionEndAppState(
  skillRoot: string,
  hook: Record<string, unknown>,
): AppState {
  return {
    sessionHooks: new Map([
      [
        getSessionId(),
        {
          hooks: {
            SessionEnd: [
              {
                matcher: 'clear',
                skillRoot,
                hooks: [{ hook }],
              },
            ],
          },
        },
      ],
    ]),
  } as unknown as AppState
}

describe('outside-REPL skill hooks', () => {
  test('set CLAUDE_PLUGIN_ROOT and expand exec-form placeholders', async () => {
    const { skillRoot, outputPath } = await createSkillHookScript()

    setIsInteractive(false)
    const appState = createSessionEndAppState(skillRoot, {
      type: 'command',
      command: '${CLAUDE_PLUGIN_ROOT}/hook.sh',
      args: ['${CLAUDE_PLUGIN_ROOT}'],
    })

    await executeSessionEndHooks('clear', {
      getAppState: () => appState,
      timeoutMs: 5000,
    })

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(
      `${skillRoot}|${skillRoot}`,
    )
  })

  test('set CLAUDE_PLUGIN_ROOT and expand shell-form placeholders', async () => {
    const { skillRoot, outputPath } = await createSkillHookScript()

    setIsInteractive(false)
    const appState = createSessionEndAppState(skillRoot, {
      type: 'command',
      command: '"${CLAUDE_PLUGIN_ROOT}/hook.sh" "${CLAUDE_PLUGIN_ROOT}"',
    })

    await executeSessionEndHooks('clear', {
      getAppState: () => appState,
      timeoutMs: 5000,
    })

    await expect(readFile(outputPath, 'utf8')).resolves.toBe(
      `${skillRoot}|${skillRoot}`,
    )
  })
})
