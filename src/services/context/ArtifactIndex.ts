import { createHash } from 'crypto'
import { appendFile, mkdir, readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { redactSecrets } from '../../utils/redaction.js'

export type ContextArtifactRef =
  | {
      kind: 'tool_result'
      id: string
      toolUseId: string
      toolName: string
      path: string
      sha256: string
      bytes: number
      preview: string
      createdAt: string
    }
  | {
      kind: 'transcript_range'
      id: string
      startUuid: string
      endUuid: string
      path: string
      createdAt: string
    }
  | {
      kind: 'summary'
      id: string
      compactId: string
      path: string
      createdAt: string
    }
  | {
      kind: 'checkpoint'
      id: string
      compactId: string
      path: string
      createdAt: string
    }

export type ArtifactSearchInput = {
  query?: string
  filePath?: string
  toolName?: string
  kind?: ContextArtifactRef['kind'] | 'transcript'
  limit?: number
  indexPath?: string
  snippetBytes?: number
}

export type ArtifactSearchResult = {
  ref: ContextArtifactRef
  score: number
  snippet?: string
  missing?: boolean
}

const DEFAULT_SNIPPET_BYTES = 2_000
const MAX_SNIPPET_BYTES = 20_000
const DEFAULT_LIMIT = 5

export function getArtifactIndexPath(transcriptPath = getTranscriptPath()): string {
  const stem = basename(transcriptPath).replace(/\.jsonl$/, '')
  return join(dirname(transcriptPath), stem, 'artifacts', 'index.jsonl')
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export async function appendArtifactRecord(
  ref: ContextArtifactRef,
  indexPath = getArtifactIndexPath(),
): Promise<void> {
  await mkdir(dirname(indexPath), { recursive: true })
  await appendFile(indexPath, `${JSON.stringify(redactArtifactRef(ref))}\n`, 'utf8')
}

export async function readArtifactIndex(
  indexPath = getArtifactIndexPath(),
): Promise<{ records: ContextArtifactRef[]; corruptLines: number }> {
  let raw: string
  try {
    raw = await readFile(indexPath, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { records: [], corruptLines: 0 }
    }
    throw error
  }

  const records: ContextArtifactRef[] = []
  let corruptLines = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as unknown
      if (isContextArtifactRef(parsed)) records.push(parsed)
      else corruptLines++
    } catch {
      corruptLines++
    }
  }
  return { records, corruptLines }
}

export async function searchArtifacts(
  input: ArtifactSearchInput,
): Promise<{ results: ArtifactSearchResult[]; corruptLines: number }> {
  const { records, corruptLines } = await readArtifactIndex(input.indexPath)
  const query = input.query?.toLowerCase().trim()
  const filePath = input.filePath?.toLowerCase().trim()
  const toolName = input.toolName?.toLowerCase().trim()
  const kind = input.kind === 'transcript' ? 'transcript_range' : input.kind
  const limit = input.limit && input.limit > 0 ? Math.min(input.limit, 20) : DEFAULT_LIMIT
  const snippetBytes = Math.max(
    0,
    Math.min(input.snippetBytes ?? DEFAULT_SNIPPET_BYTES, MAX_SNIPPET_BYTES),
  )
  const results: ArtifactSearchResult[] = []
  const seenIds = new Set<string>()

  for (const ref of records.slice().reverse()) {
    if (seenIds.has(ref.id)) continue
    seenIds.add(ref.id)
    if (kind && ref.kind !== kind) continue
    if (toolName && (!('toolName' in ref) || ref.toolName.toLowerCase() !== toolName)) {
      continue
    }
    if (filePath && (!('path' in ref) || !ref.path.toLowerCase().includes(filePath))) {
      continue
    }
    const haystack = artifactSearchText(ref).toLowerCase()
    let score = 1
    if (filePath && 'path' in ref && ref.path.toLowerCase() === filePath) score += 50
    if (query) {
      if (haystack === query) score += 40
      else if (haystack.includes(query)) score += 20
      else continue
    }
    const result: ArtifactSearchResult = { ref, score }
    if ('path' in ref) {
      const snippet = await readArtifactSnippet(ref.path, snippetBytes)
      if (snippet === null) result.missing = true
      else result.snippet = snippet
    }
    results.push(result)
  }

  return {
    results: results.sort((a, b) => b.score - a.score).slice(0, limit),
    corruptLines,
  }
}

export function buildToolResultArtifactRef(input: {
  toolUseId: string
  toolName: string
  path: string
  content: string
  preview: string
  createdAt?: string
}): ContextArtifactRef {
  return {
    kind: 'tool_result',
    id: `tool_result:${input.toolUseId}`,
    toolUseId: input.toolUseId,
    toolName: input.toolName,
    path: input.path,
    sha256: sha256Text(input.content),
    bytes: Buffer.byteLength(input.content, 'utf8'),
    preview: redactSecrets(input.preview),
    createdAt: input.createdAt ?? new Date().toISOString(),
  }
}

async function readArtifactSnippet(
  path: string,
  snippetBytes: number,
): Promise<string | null> {
  try {
    const raw = await readFile(path, 'utf8')
    return redactSecrets(raw.slice(0, snippetBytes))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
}

function redactArtifactRef(ref: ContextArtifactRef): ContextArtifactRef {
  if (ref.kind !== 'tool_result') return ref
  return { ...ref, preview: redactSecrets(ref.preview) }
}

function artifactSearchText(ref: ContextArtifactRef): string {
  switch (ref.kind) {
    case 'tool_result':
      return `${ref.toolName}\n${ref.path}\n${ref.preview}`
    case 'transcript_range':
      return `${ref.startUuid}\n${ref.endUuid}\n${ref.path}`
    case 'summary':
    case 'checkpoint':
      return `${ref.compactId}\n${ref.path}`
  }
}

function isContextArtifactRef(value: unknown): value is ContextArtifactRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  if (typeof ref.kind !== 'string' || typeof ref.id !== 'string') return false
  if (ref.kind === 'tool_result') {
    return (
      typeof ref.toolUseId === 'string' &&
      typeof ref.toolName === 'string' &&
      typeof ref.path === 'string' &&
      typeof ref.sha256 === 'string' &&
      typeof ref.bytes === 'number' &&
      typeof ref.preview === 'string' &&
      typeof ref.createdAt === 'string'
    )
  }
  if (ref.kind === 'transcript_range') {
    return (
      typeof ref.startUuid === 'string' &&
      typeof ref.endUuid === 'string' &&
      typeof ref.path === 'string' &&
      typeof ref.createdAt === 'string'
    )
  }
  if (ref.kind === 'summary' || ref.kind === 'checkpoint') {
    return (
      typeof ref.compactId === 'string' &&
      typeof ref.path === 'string' &&
      typeof ref.createdAt === 'string'
    )
  }
  return false
}
