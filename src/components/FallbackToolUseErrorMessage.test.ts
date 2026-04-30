import { describe, expect, test } from 'bun:test'
import { summarizeToolUseErrorForDisplay } from './FallbackToolUseErrorMessage.js'

describe('summarizeToolUseErrorForDisplay', () => {
  test('surfaces missing required parameters generically', () => {
    expect(
      summarizeToolUseErrorForDisplay(
        'InputValidationError: Tool failed due to the following issues:\nThe required parameter file_path is missing\nThe required parameter content is missing',
      ),
    ).toBe('Invalid tool parameters: missing file_path, content')
  })

  test('keeps concise validation detail instead of hiding it', () => {
    expect(
      summarizeToolUseErrorForDisplay(
        'InputValidationError: File has not been read yet. Read it first before writing to it.',
      ),
    ).toBe(
      'Invalid tool parameters: File has not been read yet. Read it first before writing to it.',
    )
  })

  test('truncates long compact errors', () => {
    const summary = summarizeToolUseErrorForDisplay(
      `InputValidationError: ${'x'.repeat(400)}`,
    )

    expect(summary.endsWith('…')).toBe(true)
    expect(summary.length).toBeLessThanOrEqual(220)
  })
})
