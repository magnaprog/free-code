import {
  CompactSummarySchema,
  EmergencyCompactSummarySchema,
  type ParsedCompactSummary,
} from './CompactSummarySchema.js'
import { renderCompactSummary } from './renderCompactSummary.js'

export type CompactSummaryMode = 'full' | 'emergency'

export function parseCompactSummaryJson(
  text: string,
  mode: CompactSummaryMode = 'full',
): ParsedCompactSummary {
  const jsonText = extractJsonObject(text)
  if (!jsonText) return { ok: false, error: 'No JSON object found' }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const result =
    mode === 'emergency'
      ? EmergencyCompactSummarySchema.safeParse(parsed)
      : CompactSummarySchema.safeParse(parsed)
  if (!result.success) return { ok: false, error: result.error.message }
  return { ok: true, summary: result.data }
}

export function renderStructuredCompactSummaryOrFallback(
  text: string,
  mode: CompactSummaryMode = 'full',
): { rendered: string; structured: boolean; error?: string } {
  const parsed = parseCompactSummaryJson(text, mode)
  if (!parsed.ok) return { rendered: text, structured: false, error: parsed.error }
  return { rendered: renderCompactSummary(parsed.summary), structured: true }
}

export function getRepairCompactSummaryPrompt(
  invalidJson: string,
  validationError: string,
  mode: CompactSummaryMode = 'full',
): string {
  const schemaName = mode === 'emergency' ? 'emergency compact' : 'compact'
  return `Repair this ${schemaName} summary JSON.

Rules:
- Return JSON only.
- Preserve all facts from the input.
- Do not invent file paths, commands, tests, or errors.
- Fix only syntax/schema issues.

Validation error:
${validationError}

Invalid JSON/text:
${invalidJson}`
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return extractJsonObject(fenced[1])
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return trimmed.slice(start, end + 1)
}
