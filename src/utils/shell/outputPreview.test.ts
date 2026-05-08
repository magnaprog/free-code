import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildShellOutputPreview,
  getShellModelOutputPreview,
  persistShellOutput,
  setShellModelOutputPreview,
} from './outputPreview.js'

let tempDir: string | undefined
let persistedPaths: string[] = []

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
  for (const path of persistedPaths) {
    await rm(path, { force: true })
  }
  persistedPaths = []
})

async function tempFile(content: string): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'shell-preview-'))
  const filePath = join(tempDir, 'output.txt')
  await writeFile(filePath, content)
  return filePath
}

describe('shell output preview', () => {
  test('uses bounded head and tail sections for large files', async () => {
    const filePath = await tempFile(`HEAD\n${'middle\n'.repeat(5000)}TAIL\n`)

    const preview = await buildShellOutputPreview({
      outputFilePath: filePath,
      persistedOutputPath: filePath,
    })

    expect(preview).toContain('Output too large')
    expect(preview).toContain('Full output saved to:')
    expect(preview).toContain('--- first')
    expect(preview).toContain('--- omitted')
    expect(preview).toContain('--- last')
    expect(preview).toContain('HEAD')
    expect(preview).toContain('TAIL')
    expect(preview!.length).toBeLessThan(30_000)
  })

  test('strips Claude Code hint tags from sampled output', async () => {
    const filePath = await tempFile(
      `visible\n<claude-code-hint v="1" type="plugin" value="x@y" />\n${'tail\n'.repeat(5000)}`,
    )

    const preview = await buildShellOutputPreview({
      outputFilePath: filePath,
      persistedOutputPath: filePath,
    })

    expect(preview).toContain('visible')
    expect(preview).not.toContain('<claude-code-hint')
  })

  test('caps inline preview bytes for huge single-line output', async () => {
    const preview = await buildShellOutputPreview({
      stdoutPreview: 'x'.repeat(100_000),
    })

    expect(preview).toContain('Preview')
    expect(preview).toContain('...')
    expect(preview!.length).toBeLessThan(30_000)
  })

  test('does not split UTF-8 characters when limiting inline preview text', async () => {
    const preview = await buildShellOutputPreview({
      stdoutPreview: '🙂'.repeat(10),
      headBytes: 5,
      tailBytes: 0,
    })

    expect(preview).toContain('🙂')
    expect(preview).toContain('...')
    expect(preview).not.toContain('�')
  })

  test('does not split UTF-8 characters at file preview boundaries', async () => {
    const filePath = await tempFile('🙂'.repeat(100))

    const preview = await buildShellOutputPreview({
      outputFilePath: filePath,
      headBytes: 5,
      tailBytes: 5,
    })

    expect(preview).toContain('🙂')
    expect(preview).not.toContain('�')
  })

  test('supports smaller previews for ShellError formatting', async () => {
    const filePath = await tempFile(`HEAD\n${'middle\n'.repeat(5000)}TAIL\n`)

    const preview = await buildShellOutputPreview({
      outputFilePath: filePath,
      persistedOutputPath: filePath,
      stderr: 'stderr'.repeat(1000),
      headBytes: 3 * 1024,
      tailBytes: 4 * 1024,
      stderrBytes: 1024,
    })

    expect(preview).toContain('--- first')
    expect(preview).toContain('--- last')
    expect(preview!.length).toBeLessThan(9_500)
  })

  test('model-only preview survives object spread without JSON leakage', () => {
    const output = { stdout: 'original' }
    setShellModelOutputPreview(output, 'preview')

    const clone = { ...output }

    expect(getShellModelOutputPreview(clone)).toBe('preview')
    expect(JSON.stringify(clone)).toBe('{"stdout":"original"}')
  })

  test('labels truncated persisted output preview clearly', async () => {
    const filePath = await tempFile('content')

    const preview = await buildShellOutputPreview({
      outputFilePath: filePath,
      persistedOutputPath: filePath,
      originalSizeBytes: 100,
      persistedSizeBytes: 10,
      persistedWasTruncated: true,
    })

    expect(preview).toContain('truncated to 10 bytes')
    expect(preview).toContain('not the original tail')
  })

  test('can omit wrapper for ShellError previews', async () => {
    const preview = await buildShellOutputPreview({
      stdoutPreview: 'failure output',
      includeWrapper: false,
    })

    expect(preview).toContain('failure output')
    expect(preview).not.toContain('<persisted-output>')
  })

  test('does not truncate source file when persisting capped output', async () => {
    const filePath = await tempFile('0123456789abcdefghij')
    const persisted = await persistShellOutput(filePath, 'task-test', 10)
    if (persisted) persistedPaths.push(persisted.filepath)

    expect(persisted).not.toBeNull()
    expect(persisted!.originalSize).toBe(20)
    expect(persisted!.persistedSize).toBe(10)
    expect(persisted!.truncated).toBe(true)
    expect((await stat(filePath)).size).toBe(20)
    expect(await readFile(filePath, 'utf8')).toBe('0123456789abcdefghij')
    expect(await readFile(persisted!.filepath, 'utf8')).toBe('0123456789')
  })
})
