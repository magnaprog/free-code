import { copyFile, link, open, stat as fsStat, unlink } from 'fs/promises'
import { extractClaudeCodeHints } from '../claudeCodeHints.js'
import { readFileRange, tailFile } from '../fsOperations.js'
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
  const fullPreviewBytes = headBytes + tailBytes
  const head = await readFileRange(sourcePath, 0, fullPreviewBytes)
  if (!head) {
    return {
      totalBytes: 0,
      lines: ['Preview:', ''],
    }
  }

  if (head.bytesTotal <= fullPreviewBytes) {
    return {
      totalBytes: head.bytesTotal,
      lines: [
        `Preview (${formatFileSize(head.bytesRead)}):`,
        cleanPreviewText(head.content),
      ],
    }
  }

  const headOnly = await readFileRange(sourcePath, 0, headBytes)
  const tail = await tailFile(sourcePath, tailBytes)
  const actualHeadBytes = headOnly?.bytesRead ?? 0
  const actualTailBytes = tail.bytesRead
  const omittedBytes = Math.max(0, tail.bytesTotal - actualHeadBytes - actualTailBytes)

  return {
    totalBytes: tail.bytesTotal,
    lines: [
      `Preview (first ${formatFileSize(actualHeadBytes)}, last ${formatFileSize(actualTailBytes)}):`,
      `--- first ${formatFileSize(actualHeadBytes)} ---`,
      cleanPreviewText(headOnly?.content ?? ''),
      '',
      `--- omitted ${formatFileSize(omittedBytes)} ---`,
      '',
      `--- last ${formatFileSize(actualTailBytes)} ---`,
      cleanPreviewText(tail.content),
    ],
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
  return `${buffer.toString('utf8', 0, maxBytes).trimEnd()}\n...`
}
