import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  DEFAULT_SESSION_MEMORY_TEMPLATE,
  isSessionMemoryEmpty,
} from './prompts.js'

const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
let tempDir: string | undefined

const OLD_DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`

async function useCustomTemplate(template: string): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), 'free-code-session-memory-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  const configDir = join(tempDir, 'session-memory', 'config')
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'template.md'), template)
}

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
  }

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('isSessionMemoryEmpty', () => {
  test('treats the current default template as empty', async () => {
    expect(await isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(
      true,
    )
  })

  test('treats older built-in templates as empty', async () => {
    expect(await isSessionMemoryEmpty(OLD_DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(
      true,
    )
  })

  test('treats custom templates as empty', async () => {
    const template = `# Notes\nKeep this exact custom scaffold.\n- Fill this in later.`
    await useCustomTemplate(template)

    expect(await isSessionMemoryEmpty(template)).toBe(true)
  })

  test('detects content below template descriptions', async () => {
    const memory = `${DEFAULT_SESSION_MEMORY_TEMPLATE}\n- User is debugging compact environment setup.`

    expect(await isSessionMemoryEmpty(memory)).toBe(false)
  })

  test('detects italic content under custom headings', async () => {
    await useCustomTemplate('# Notes')

    expect(await isSessionMemoryEmpty('# Notes\n_Keep this detail._')).toBe(
      false,
    )
  })
})
