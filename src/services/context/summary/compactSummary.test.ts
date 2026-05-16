import { describe, expect, test } from 'bun:test'
import { getStructuredCompactPrompt } from './generateCompactSummary.js'
import {
  getRepairCompactSummaryPrompt,
  parseCompactSummaryJson,
  renderStructuredCompactSummaryOrFallback,
} from './repairCompactSummary.js'

const validFullSummary = {
  schemaVersion: 1,
  sourceRange: { startUuid: 'a', endUuid: 'b', transcriptPath: '/tmp/t.jsonl' },
  primaryRequest: 'Implement compaction.',
  activeTask: 'Wire structured summary.',
  hardConstraints: ['No live API calls'],
  userPreferences: ['Keep changes minimal'],
  files: [
    {
      path: 'src/services/compact/compact.ts',
      role: 'modified',
      facts: ['structured summaries are gated'],
      latestKnownState: 'tests pass',
    },
  ],
  commands: [
    {
      command: 'bun test src/services/context/summary/compactSummary.test.ts',
      outcome: 'pass',
    },
  ],
  errors: [
    {
      symptom: 'invalid JSON',
      fixAttempted: 'repair prompt',
      status: 'resolved',
    },
  ],
  decisions: [{ decision: 'Keep markdown fallback' }],
  tests: [{ command: 'bun test', result: 'pass' }],
  plan: [{ item: 'structured summary', status: 'doing' }],
  nextAction: 'Continue artifact recall.',
  artifactRefs: [{ kind: 'summary', id: 's1', summary: 'structured summary' }],
  doNotForget: ['Preserve exact file paths'],
}

describe('structured compact summary', () => {
  test('parses and renders valid structured compact JSON', () => {
    const rendered = renderStructuredCompactSummaryOrFallback(
      JSON.stringify(validFullSummary),
    )

    expect(rendered.structured).toBe(true)
    expect(rendered.rendered).toContain('src/services/compact/compact.ts')
    expect(rendered.rendered).toContain('Continue artifact recall.')
  })

  test('falls back to original markdown when parsing fails', () => {
    const markdown = '<summary>plain fallback</summary>'
    const rendered = renderStructuredCompactSummaryOrFallback(markdown)

    expect(rendered.structured).toBe(false)
    expect(rendered.rendered).toBe(markdown)
    expect(rendered.error).toBeTruthy()
  })

  test('accepts emergency schema separately from full schema', () => {
    const emergency = {
      schemaVersion: 1,
      activeTask: 'Recover after overflow',
      hardConstraints: ['retry once'],
      changedFiles: ['src/query.ts'],
      failingTests: [],
      nextAction: 'Retry compact.',
      artifactRefs: [{ id: 'a1', summary: 'overflow context' }],
    }

    const fullParsed = parseCompactSummaryJson(JSON.stringify(emergency), 'full')
    const emergencyParsed = parseCompactSummaryJson(
      JSON.stringify(emergency),
      'emergency',
    )

    expect(fullParsed.ok).toBe(false)
    expect(emergencyParsed.ok).toBe(true)
  })

  test('repair prompt asks for JSON only and preserves facts', () => {
    const prompt = getRepairCompactSummaryPrompt('{bad', 'Expected object')

    expect(prompt).toContain('Return JSON only')
    expect(prompt).toContain('Do not invent')
    expect(prompt).toContain('Expected object')
  })

  test('generation prompt does not require provider JSON mode', () => {
    const prompt = getStructuredCompactPrompt('keep tests')

    expect(prompt).toContain('Return plain JSON only')
    expect(prompt).toContain('Additional Instructions')
    expect(prompt).not.toContain('response_format')
  })
})
