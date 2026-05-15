import { createHash } from 'crypto'
import { appendFile, mkdir, open, readFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import { redactSecrets } from '../../utils/redaction.js'

// Tool-results dir is at `${sessionDir}/tool-results`; we derive sessionDir
// from the transcript path to avoid importing from toolResultStorage.ts
// (which itself imports from this file — circular).
const TOOL_RESULTS_SUBDIR = 'tool-results'
const ARTIFACTS_SUBDIR = 'artifacts'

function getSessionDirFromTranscript(transcriptPath: string): string {
  const stem = basename(transcriptPath).replace(/\.jsonl$/, '')
  return join(dirname(transcriptPath), stem)
}

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
  return join(getSessionDirFromTranscript(transcriptPath), ARTIFACTS_SUBDIR, 'index.jsonl')
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
  const candidates: ArtifactSearchResult[] = []
  const seenIds = new Set<string>()

  // Phase 1: score and filter, do NOT read snippets yet (B9 fix avoids
  // reading megabytes for results we'll drop after sort+limit).
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
    candidates.push({ ref, score })
  }

  // Phase 2: sort + limit, THEN read snippets only for top-K results.
  const ranked = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  const effectiveIndexPath = input.indexPath ?? getArtifactIndexPath()
  const allowedRoots = getAllowedArtifactRoots(effectiveIndexPath)

  for (const result of ranked) {
    if ('path' in result.ref) {
      const snippet = await readArtifactSnippet(
        result.ref.path,
        snippetBytes,
        allowedRoots,
      )
      if (snippet === null) result.missing = true
      else result.snippet = snippet
    }
  }

  return { results: ranked, corruptLines }
}

/**
 * B13: validate that `path` points inside one of the allowed session
 * artifact roots. Rejects absolute paths outside roots, `../..` traversal,
 * and any path that resolves outside the expected directories.
 *
 * Note: this does NOT resolve symlinks (avoids fs.realpath which fails on
 * missing files). A symlink pointing outside an allowed root would slip
 * past this check. Treat the disk layout as trusted; only the JSONL index
 * is the threat surface.
 */
/**
 * Allowed roots for artifact paths, derived from the index path itself.
 * In production: ${sessionDir}/artifacts/index.jsonl → allowed roots are
 *   ${sessionDir}/artifacts (where index lives)
 *   ${sessionDir}/tool-results (sibling — where persisted results live)
 * Co-locating roots with the index file keeps the threat model contained:
 * a tampered JSONL can only reference files inside the same session tree.
 */
function getAllowedArtifactRoots(indexPath: string): string[] {
  const artifactsDir = dirname(indexPath)
  const sessionDir = dirname(artifactsDir)
  return [artifactsDir, join(sessionDir, TOOL_RESULTS_SUBDIR)]
}

function isPathInAllowedRoot(targetPath: string, allowedRoots: string[]): boolean {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(targetPath)
  for (const root of allowedRoots) {
    const rel = relative(resolve(root), absolute)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      return true
    }
  }
  return false
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
  allowedRoots: string[],
): Promise<string | null> {
  // B13: reject paths outside allowed session roots before opening.
  if (!isPathInAllowedRoot(path, allowedRoots)) {
    return null
  }
  if (snippetBytes <= 0) {
    return ''
  }
  // B9: partial read instead of loading the whole file into memory.
  let fh
  try {
    fh = await open(path, 'r')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null
    throw error
  }
  try {
    const buf = Buffer.alloc(snippetBytes)
    const { bytesRead } = await fh.read(buf, 0, snippetBytes, 0)
    return redactSecrets(buf.toString('utf8', 0, bytesRead))
  } finally {
    await fh.close()
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
