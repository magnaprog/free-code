import { copyFile, link, open, stat as fsStat, unlink } from 'fs/promises'
import { extractClaudeCodeHints } from '../claudeCodeHints.js'
import { formatFileSize } from '../format.js'
import {
  ensureToolResultsDir,
  getToolResultPath,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
} from '../toolResultStorage.js'

const HEAD_PREVIEW_BYTES = 8 * 1024
const TAIL_PREVIEW_BYTES = 12 * 1024
const SHELL_ERROR_HEAD_PREVIEW_BYTES = 3 * 1024
const SHELL_ERROR_TAIL_PREVIEW_BYTES = 4 * 1024
const SHELL_ERROR_STDERR_PREVIEW_BYTES = 1024
export const MAX_PERSISTED_SHELL_OUTPUT_BYTES = 64 * 1024 * 1024

export const SHELL_MODEL_OUTPUT_PREVIEW = Symbol('shellModelOutputPreview')

type ShellPreviewCarrier = {
  [SHELL_MODEL_OUTPUT_PREVIEW]?: string
}

export type PersistedShellOutput = {
  filepath: string
  originalSize: number
  persistedSize: number
  truncated: boolean
}

export function setShellModelOutputPreview(output: object, preview: string): void {
  Object.defineProperty(output, SHELL_MODEL_OUTPUT_PREVIEW, {
    value: preview,
    enumerable: true,
    configurable: true,
  })
}

export function getShellModelOutputPreview(output: object): string | undefined {
  const preview = (output as ShellPreviewCarrier)[SHELL_MODEL_OUTPUT_PREVIEW]
  return typeof preview === 'string' ? preview : undefined
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

export type ShellErrorOutputPreviewInput = {
  outputFilePath?: string
  outputTaskId?: string
  originalSizeBytes?: number
  stderr?: string
  stderrLabel?: string
}

export async function persistShellOutput(
  outputFilePath: string | undefined,
  outputTaskId: string | undefined,
  maxBytes: number = MAX_PERSISTED_SHELL_OUTPUT_BYTES,
): Promise<PersistedShellOutput | null> {
  if (!outputFilePath || !outputTaskId) return null

  let dest: string | undefined
  try {
    const fileStat = await fsStat(outputFilePath)
    const originalSize = fileStat.size
    await ensureToolResultsDir()
    dest = getToolResultPath(outputTaskId, false)

    if (originalSize > maxBytes) {
      const persistedSize = await copyFilePrefix(
        outputFilePath,
        dest,
        maxBytes,
      )
      return {
        filepath: dest,
        originalSize,
        persistedSize,
        truncated: true,
      }
    }

    try {
      await link(outputFilePath, dest)
    } catch {
      await copyFile(outputFilePath, dest)
    }

    return {
      filepath: dest,
      originalSize,
      persistedSize: originalSize,
      truncated: false,
    }
  } catch {
    if (dest) {
      await unlink(dest).catch(() => {})
    }
    return null
  }
}

export async function buildShellErrorOutputPreview({
  outputFilePath,
  outputTaskId,
  originalSizeBytes,
  stderr = '',
  stderrLabel,
}: ShellErrorOutputPreviewInput): Promise<string | null> {
  const persistedOutput = await persistShellOutput(outputFilePath, outputTaskId)
  return persistedOutput
    ? buildShellOutputPreview({
      persistedOutputPath: persistedOutput.filepath,
      originalSizeBytes: persistedOutput.originalSize,
      persistedSizeBytes: persistedOutput.persistedSize,
      persistedWasTruncated: persistedOutput.truncated,
      stderr,
      ...(stderrLabel === undefined ? {} : { stderrLabel }),
      headBytes: SHELL_ERROR_HEAD_PREVIEW_BYTES,
      tailBytes: SHELL_ERROR_TAIL_PREVIEW_BYTES,
      stderrBytes: SHELL_ERROR_STDERR_PREVIEW_BYTES,
      includeWrapper: false,
    })
    : outputFilePath
      ? buildShellOutputPreview({
        outputFilePath,
        originalSizeBytes,
        stderr,
        stderrLabel,
        headBytes: SHELL_ERROR_HEAD_PREVIEW_BYTES,
        tailBytes: SHELL_ERROR_TAIL_PREVIEW_BYTES,
        stderrBytes: SHELL_ERROR_STDERR_PREVIEW_BYTES,
        includeWrapper: false,
      })
      : null
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
    if (!sections) return null

    const originalSize = originalSizeBytes ?? sections.totalBytes
    const persistedSize = persistedSizeBytes ?? sections.totalBytes
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
    } else if (originalSize > sections.totalBytes) {
      lines.push('Full output could not be saved; showing captured preview only.')
    }

    const cleanedStderr = cleanPreviewText(stderr).trim()
    if (cleanedStderr) {
      lines.push('')
      lines.push(stderrLabel)
      lines.push(limitText(cleanedStderr, stderrBytes))
    }

    lines.push('')
    lines.push(...sections.lines)
    if (includeWrapper) {
      lines.push(PERSISTED_OUTPUT_CLOSING_TAG)
    }

    return lines.join('\n')
  } catch {
    return null
  }
}

async function copyFilePrefix(
  sourcePath: string,
  destPath: string,
  maxBytes: number,
): Promise<number> {
  await using source = await open(sourcePath, 'r')
  await using dest = await open(destPath, 'w')
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
    readFileSlice(sourcePath, 0, actualHeadBytes),
    readFileSlice(sourcePath, totalBytes - actualTailBytes, actualTailBytes),
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
): Promise<{ content: string; bytesRead: number }> {
  if (maxBytes <= 0) return { content: '', bytesRead: 0 }

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

  const content = decodePreviewBuffer(buffer.subarray(0, totalRead))
  return { content, bytesRead: totalRead }
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
  return `${decodePreviewBuffer(buffer.subarray(0, maxBytes)).trimEnd()}\n...`
}

function decodePreviewBuffer(buffer: Buffer): string {
  let start = 0
  let end = buffer.length

  while (start < end && isUtf8ContinuationByte(buffer[start] ?? 0)) {
    start++
  }

  end = trimIncompleteUtf8End(buffer, start, end)
  return buffer.toString('utf8', start, end)
}

function trimIncompleteUtf8End(
  buffer: Buffer,
  start: number,
  end: number,
): number {
  let lead = end - 1
  while (lead >= start && isUtf8ContinuationByte(buffer[lead] ?? 0)) {
    lead--
  }
  if (lead < start) return start

  const sequenceLength = getUtf8SequenceLength(buffer[lead] ?? 0)
  if (sequenceLength > 0 && lead + sequenceLength > end) {
    return lead
  }
  return end
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80
}

function getUtf8SequenceLength(byte: number): number {
  if ((byte & 0x80) === 0) return 1
  if ((byte & 0xe0) === 0xc0) return 2
  if ((byte & 0xf0) === 0xe0) return 3
  if ((byte & 0xf8) === 0xf0) return 4
  return 0
}
