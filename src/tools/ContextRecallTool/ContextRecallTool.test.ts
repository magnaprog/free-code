import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendArtifactRecord,
  buildToolResultArtifactRef,
} from '../../services/context/ArtifactIndex.js'
import { searchContextArtifacts } from './ContextRecallTool.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'free-code-context-recall-'))
  tempDirs.push(dir)
  return dir
}

describe('ContextRecallTool', () => {
  test('searches artifact index with redacted snippets', async () => {
    const dir = await makeTempDir()
    const artifactPath = join(dir, 'bash-output.txt')
    const indexPath = join(dir, 'index.jsonl')
    const content = 'target line\nAuthorization: Bearer fake-recall-secret\n'

    await writeFile(artifactPath, content, 'utf8')
    await appendArtifactRecord(
      buildToolResultArtifactRef({
        toolUseId: 'toolu_recall',
        toolName: 'Bash',
        path: artifactPath,
        content,
        preview: content,
      }),
      indexPath,
    )

    const output = await searchContextArtifacts(
      { query: 'target', toolName: 'Bash', limit: 5 },
      indexPath,
    )

    expect(output.corruptLines).toBe(0)
    expect(output.results).toHaveLength(1)
    expect(output.results[0]?.toolName).toBe('Bash')
    expect(output.results[0]?.snippet).toContain('Bearer [REDACTED]')
    expect(output.results[0]?.snippet).not.toContain('fake-recall-secret')
  })
})
