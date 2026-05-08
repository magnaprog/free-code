import { link, open, stat as fsStat, unlink } from 'fs/promises'
import { extractClaudeCodeHints } from '../claudeCodeHints.js'
import { getErrnoCode } from '../errors.js'
import { formatFileSize } from '../format.js'
import {
  ensureToolResultsDir,
  getToolResultPath,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
} from '../toolResultStorage.js'

const HEAD_PREVIEW_BYTES = 8 * 1024
const TAIL_PREVIEW_BYTES = 12 * 1024
export const MAX_PERSISTED_SHELL_OUTPUT_BYTES = 64 * 1024 * 1024

const shellModelOutputPreviews = new WeakMap<object, string>()

export type PersistedShellOutput = {
  filepath: string
  originalSize: number
  persistedSize: number
  truncated: boolean
}

export function setShellModelOutputPreview(output: object, preview: string): void {
  shellModelOutputPreviews.set(output, preview)
}

export function getShellModelOutputPreview(output: object): string | undefined {
  return shellModelOutputPreviews.get(output)
}

export function copyShellModelOutputPreview(source: object, target: object): void {
  const preview = getShellModelOutputPreview(source)
  if (preview !== undefined) {
    setShellModelOutputPreview(target, preview)
  }
}

export type ShellOutputPreviewInput = {
  outputFilePath?: string
  persistedOutputPath?: string
  originalSizeBytes?: number
  persistedSizeBytes?: number
  persistedWasTruncated?: boolean
  stdoutPreview?: string
  stderr?: string
  stderrLabel?: string
  headBytes?: number
  tailBytes?: number
  stderrBytes?: number
  includeWrapper?: boolean
}

export async function persistShellOutput(
  outputFilePath: string | undefined,
  outputTaskId: string | undefined,
  maxBytes: number = MAX_PERSISTED_SHELL_OUTPUT_BYTES,
): Promise<PersistedShellOutput | null> {
  if (!outputFilePath || !outputTaskId) return null

  try {
    const fileStat = await fsStat(outputFilePath)
    const originalSize = fileStat.size
    await ensureToolResultsDir()
    const dest = getToolResultPath(outputTaskId, false)

    if (originalSize > maxBytes) {
      try {
        const persistedSize = await copyFilePrefix(outputFilePath, dest, maxBytes)
        return {
          filepath: dest,
          originalSize,
          persistedSize,
          truncated: true,
        }
      } catch (error) {
        if (getErrnoCode(error) === 'EEXIST') {
          return await getExistingPersistedShellOutput(dest, originalSize)
        }
        return null
      }
    }

    try {
      await link(outputFilePath, dest)
      return {
        filepath: dest,
        originalSize,
        persistedSize: originalSize,
        truncated: false,
      }
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST') {
        return await getExistingPersistedShellOutput(dest, originalSize)
      }
    }

    try {
      const persistedSize = await copyFilePrefix(outputFilePath, dest, originalSize)
      return {
        filepath: dest,
        originalSize,
        persistedSize,
        truncated: persistedSize < originalSize,
      }
    } catch (error) {
      if (getErrnoCode(error) === 'EEXIST') {
        return await getExistingPersistedShellOutput(dest, originalSize)
      }
      return null
    }
  } catch {
    return null
  }
}

export async function buildShellOutputPreview({
  outputFilePath,
  persistedOutputPath,
  originalSizeBytes,
  persistedSizeBytes,
  persistedWasTruncated = false,
  stdoutPreview = '',
  stderr = '',
  stderrLabel = 'Stderr:',
  headBytes = HEAD_PREVIEW_BYTES,
  tailBytes = TAIL_PREVIEW_BYTES,
  stderrBytes = HEAD_PREVIEW_BYTES,
  includeWrapper = true,
}: ShellOutputPreviewInput): Promise<string | null> {
  const sourcePath = persistedOutputPath ?? outputFilePath
  if (!sourcePath && !stdoutPreview && !stderr) return null

  try {
    const sections = sourcePath
      ? await buildFileSections(sourcePath, headBytes, tailBytes)
      : buildInlineSections(stdoutPreview, headBytes + tailBytes)
    if (!sections && !stderr) return null

    const originalSize = originalSizeBytes ?? sections?.totalBytes ?? 0
    const persistedSize = persistedSizeBytes ?? sections?.totalBytes ?? 0
    const lines: string[] = includeWrapper ? [PERSISTED_OUTPUT_TAG] : []

    lines.push(`Output too large (${formatFileSize(originalSize)}).`)
    if (persistedOutputPath) {
      if (persistedWasTruncated) {
        lines.push(
          `Output saved to: ${persistedOutputPath} (truncated to ${formatFileSize(persistedSize)}).`,
        )
        lines.push('Preview below is from the saved truncated output, not the original tail.')
      } else {
        lines.push(`Full output saved to: ${persistedOutputPath}.`)
      }
    } else if (sections && originalSize > sections.totalBytes) {
      lines.push('Full output could not be saved; showing captured preview only.')
    }

    const cleanedStderr = cleanPreviewText(stderr).trim()
    if (cleanedStderr) {
      lines.push('')
      lines.push(stderrLabel)
      lines.push(limitText(cleanedStderr, stderrBytes))
    }

    if (sections) {
      lines.push('')
      lines.push(...sections.lines)
    }
    if (includeWrapper) {
      lines.push(PERSISTED_OUTPUT_CLOSING_TAG)
    }

    return lines.join('\n')
  } catch {
    return null
  }
}

async function getExistingPersistedShellOutput(
  filepath: string,
  originalSize: number,
): Promise<PersistedShellOutput | null> {
  try {
    const existingStat = await fsStat(filepath)
    return {
      filepath,
      originalSize,
      persistedSize: existingStat.size,
      truncated: existingStat.size < originalSize,
    }
  } catch {
    return null
  }
}

async function copyFilePrefix(
  sourcePath: string,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  let createdDest = false
  try {
    await using source = await open(sourcePath, 'r')
    await using dest = await open(destPath, 'wx')
    createdDest = true
    const buffer = Buffer.allocUnsafe(Math.min(maxBytes, 1024 * 1024))
    let bytesCopied = 0

    while (bytesCopied < maxBytes) {
      const bytesToRead = Math.min(buffer.length, maxBytes - bytesCopied)
      const { bytesRead } = await source.read(
        buffer,
        0,
        bytesToRead,
        bytesCopied,
      )
      if (bytesRead === 0) break
      await dest.write(buffer, 0, bytesRead)
      bytesCopied += bytesRead
    }

    return bytesCopied
  } catch (error) {
    if (createdDest) {
      await unlink(destPath).catch(() => {})
    }
    throw error
  }
}

async function buildFileSections(
  sourcePath: string,
  headBytes: number,
  tailBytes: number,
): Promise<{ lines: string[]; totalBytes: number } | null> {
  const totalBytes = (await fsStat(sourcePath)).size
  const fullPreviewBytes = headBytes + tailBytes
  if (totalBytes === 0) {
    return {
      totalBytes: 0,
      lines: ['Preview:', ''],
    }
  }

  if (totalBytes <= fullPreviewBytes) {
    const full = await readFileSlice(sourcePath, 0, totalBytes)
    return {
      totalBytes,
      lines: [
        `Preview (${formatFileSize(full.bytesRead)}):`,
        cleanPreviewText(full.content),
      ],
    }
  }

  const actualHeadBytes = Math.min(headBytes, totalBytes)
  const actualTailBytes = Math.min(tailBytes, totalBytes - actualHeadBytes)
  const [head, tail] = await Promise.all([
    readFileSlice(sourcePath, 0, actualHeadBytes, {
      trimTrailingPartialCharacter: true,
    }),
    readTailFileSlice(sourcePath, totalBytes - actualTailBytes, actualTailBytes),
  ])
  const omittedBytes = Math.max(0, totalBytes - head.bytesRead - tail.bytesRead)

  return {
    totalBytes,
    lines: [
      `Preview (first ${formatFileSize(head.bytesRead)}, last ${formatFileSize(tail.bytesRead)}):`,
      `--- first ${formatFileSize(head.bytesRead)} ---`,
      cleanPreviewText(head.content),
      '',
      `--- omitted ${formatFileSize(omittedBytes)} ---`,
      '',
      `--- last ${formatFileSize(tail.bytesRead)} ---`,
      cleanPreviewText(tail.content),
    ],
  }
}

async function readFileSlice(
  sourcePath: string,
  offset: number,
  maxBytes: number,
  {
    trimTrailingPartialCharacter = false,
  }: {
    trimTrailingPartialCharacter?: boolean
  } = {},
): Promise<{ content: string; bytesRead: number }> {
  if (maxBytes <= 0) return { content: '', bytesRead: 0 }

  const bytesToRead = trimTrailingPartialCharacter ? maxBytes + 3 : maxBytes
  const { buffer, bytesRead } = await readFileBuffer(sourcePath, offset, bytesToRead)
  const visibleBytes = Math.min(bytesRead, maxBytes)
  const content = decodePreviewBuffer(buffer, {
    visibleBytes,
    trimTrailingPartialCharacter,
  })
  return { content, bytesRead: visibleBytes }
}

async function readTailFileSlice(
  sourcePath: string,
  offset: number,
  maxBytes: number,
): Promise<{ content: string; bytesRead: number }> {
  if (maxBytes <= 0) return { content: '', bytesRead: 0 }

  const contextBytes = Math.min(offset, 3)
  const contextOffset = offset - contextBytes
  const { buffer, bytesRead } = await readFileBuffer(
    sourcePath,
    contextOffset,
    maxBytes + contextBytes,
  )
  const sliceStart = Math.min(contextBytes, bytesRead)
  const content = decodeTailPreviewBuffer(buffer, sliceStart)
  return { content, bytesRead: Math.max(0, bytesRead - sliceStart) }
}

async function readFileBuffer(
  sourcePath: string,
  offset: number,
  maxBytes: number,
): Promise<{ buffer: Buffer; bytesRead: number }> {
  await using file = await open(sourcePath, 'r')
  const buffer = Buffer.allocUnsafe(maxBytes)
  let totalRead = 0

  while (totalRead < maxBytes) {
    const { bytesRead } = await file.read(
      buffer,
      totalRead,
      maxBytes - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) break
    totalRead += bytesRead
  }

  return {
    buffer: buffer.subarray(0, totalRead),
    bytesRead: totalRead,
  }
}

function buildInlineSections(
  stdoutPreview: string,
  maxPreviewBytes: number,
): { lines: string[]; totalBytes: number } | null {
  const cleaned = cleanPreviewText(stdoutPreview)
  if (!cleaned) return null
  const limited = limitText(cleaned, maxPreviewBytes)
  return {
    totalBytes: Buffer.byteLength(cleaned, 'utf8'),
    lines: [`Preview (${formatFileSize(Buffer.byteLength(limited, 'utf8'))}):`, limited],
  }
}

function cleanPreviewText(text: string): string {
  if (!text) return ''
  return extractClaudeCodeHints(text, '').stripped.replace(/^(\s*\n)+/, '').trimEnd()
}

function limitText(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return `${decodePreviewBuffer(buffer, {
    visibleBytes: maxBytes,
    trimTrailingPartialCharacter: true,
  }).trimEnd()}\n...`
}

function decodePreviewBuffer(
  buffer: Buffer,
  {
    visibleBytes = buffer.length,
    trimTrailingPartialCharacter = false,
  }: {
    visibleBytes?: number
    trimTrailingPartialCharacter?: boolean
  } = {},
): string {
  let end = Math.min(visibleBytes, buffer.length)

  if (trimTrailingPartialCharacter) {
    end = trimIncompleteUtf8End(buffer, 0, end, buffer.length)
  }
  return buffer.toString('utf8', 0, end)
}

function decodeTailPreviewBuffer(buffer: Buffer, sliceStart: number): string {
  const start = getTailDecodeStart(buffer, sliceStart)
  const end = trimIncompleteUtf8End(buffer, start, buffer.length, buffer.length)
  return buffer.toString('utf8', start, end)
}

function getTailDecodeStart(buffer: Buffer, sliceStart: number): number {
  if (!isUtf8ContinuationByte(buffer[sliceStart] ?? 0)) {
    return sliceStart
  }

  let lead = sliceStart - 1
  while (lead >= 0 && isUtf8ContinuationByte(buffer[lead] ?? 0)) {
    lead--
  }
  if (lead < 0) {
    return sliceStart
  }

  const sequenceLength = getUtf8SequenceLength(buffer[lead] ?? 0)
  if (
    sequenceLength > 0 &&
    lead + sequenceLength > sliceStart &&
    lead + sequenceLength <= buffer.length &&
    hasExpectedContinuationBytes(buffer, lead, sequenceLength)
  ) {
    return lead + sequenceLength
  }
  return sliceStart
}

function trimIncompleteUtf8End(
  buffer: Buffer,
  start: number,
  end: number,
  availableEnd: number,
): number {
  let lead = end - 1
  while (lead >= start && isUtf8ContinuationByte(buffer[lead] ?? 0)) {
    lead--
  }
  if (lead < start) return end

  const sequenceLength = getUtf8SequenceLength(buffer[lead] ?? 0)
  if (sequenceLength > 0 && lead + sequenceLength > end) {
    if (
      lead + sequenceLength <= availableEnd &&
      hasExpectedContinuationBytes(buffer, lead, sequenceLength)
    ) {
      return lead
    }
    return end
  }
  return end
}

function hasExpectedContinuationBytes(
  buffer: Buffer,
  lead: number,
  sequenceLength: number,
): boolean {
  for (let i = 1; i < sequenceLength; i++) {
    if (!isUtf8ContinuationByte(buffer[lead + i] ?? 0)) {
      return false
    }
  }
  return true
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function getUtf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1
  if (byte >= 0xc2 && byte <= 0xdf) return 2
  if (byte >= 0xe0 && byte <= 0xef) return 3
  if (byte >= 0xf0 && byte <= 0xf4) return 4
  return 0
}
