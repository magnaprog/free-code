import { afterEach, describe, expect, test } from 'bun:test'
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  appendArtifactRecord,
  buildToolResultArtifactRef,
  getArtifactIndexPath,
  readArtifactIndex,
  searchArtifacts,
} from './ArtifactIndex.js'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'free-code-artifacts-'))
  tempDirs.push(dir)
  return dir
}

describe('ArtifactIndex', () => {
  test('derives artifact index path from transcript path', () => {
    expect(getArtifactIndexPath('/tmp/project/session-id.jsonl')).toBe(
      '/tmp/project/session-id/artifacts/index.jsonl',
    )
  })

  test('reads corrupt lines, redacts snippets, and deduplicates records', async () => {
    const dir = await makeTempDir()
    const artifactPath = join(dir, 'tool-result.txt')
    const indexPath = join(dir, 'index.jsonl')
    const content =
      'Needle Authorization: Bearer fake-secret-token\n' + 'safe text\n'.repeat(100)

    await writeFile(artifactPath, content, 'utf8')
    const ref = buildToolResultArtifactRef({
      toolUseId: 'toolu_1',
      toolName: 'Bash',
      path: artifactPath,
      content,
      preview: 'Needle Authorization: Bearer fake-secret-token',
      createdAt: '2026-05-14T00:00:00.000Z',
    })
    await appendArtifactRecord(ref, indexPath)
    await appendArtifactRecord(ref, indexPath)
    await appendFile(indexPath, 'not-json\n', 'utf8')

    const { records, corruptLines: readCorruptLines } =
      await readArtifactIndex(indexPath)
    expect(records).toHaveLength(2)
    expect(readCorruptLines).toBe(1)
    expect(records[0]?.kind).toBe('tool_result')
    if (records[0]?.kind !== 'tool_result') throw new Error('wrong ref kind')
    expect(records[0].preview).toContain('Bearer [REDACTED]')
    expect(records[0].preview).not.toContain('fake-secret-token')

    const { results, corruptLines } = await searchArtifacts({
      query: 'Needle',
      indexPath,
      snippetBytes: 128,
      limit: 20,
    })

    expect(corruptLines).toBe(1)
    expect(results).toHaveLength(1)
    expect(results[0]?.snippet).toContain('Bearer [REDACTED]')
    expect(results[0]?.snippet).not.toContain('fake-secret-token')
  })

  test('caps snippets and tolerates missing artifact files', async () => {
    const dir = await makeTempDir()
    const artifactPath = join(dir, 'large.txt')
    const missingPath = join(dir, 'missing.txt')
    const indexPath = join(dir, 'index.jsonl')

    await writeFile(artifactPath, 'x'.repeat(30_000), 'utf8')
    await appendArtifactRecord(
      buildToolResultArtifactRef({
        toolUseId: 'toolu_large',
        toolName: 'Read',
        path: artifactPath,
        content: 'x'.repeat(30_000),
        preview: 'x'.repeat(2_000),
      }),
      indexPath,
    )
    await appendArtifactRecord(
      buildToolResultArtifactRef({
        toolUseId: 'toolu_missing',
        toolName: 'Read',
        path: missingPath,
        content: 'missing content',
        preview: 'missing content',
      }),
      indexPath,
    )

    const large = await searchArtifacts({
      toolName: 'Read',
      filePath: artifactPath,
      indexPath,
      snippetBytes: 1_000_000,
    })
    expect(large.results[0]?.snippet).toHaveLength(20_000)

    const missing = await searchArtifacts({
      toolName: 'Read',
      filePath: missingPath,
      indexPath,
    })
    expect(missing.results[0]?.missing).toBe(true)
    expect(missing.results[0]?.snippet).toBeUndefined()
  })
})
