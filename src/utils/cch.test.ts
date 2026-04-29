import { describe, expect, test } from 'bun:test'
import { hasCchPlaceholder, replaceCchPlaceholder } from './cch.js'

describe('CCH placeholder replacement', () => {
  test('detects only billing header placeholders', () => {
    const userOnlyBody = JSON.stringify({
      messages: [{ role: 'user', content: 'literal cch=00000 value' }],
    })

    expect(hasCchPlaceholder(userOnlyBody)).toBe(false)
  })

  test('replaces the billing header placeholder without mutating earlier user content', () => {
    const userContent =
      'debug x-anthropic-billing-header with literal cch=00000 value'
    const body = JSON.stringify({
      messages: [{ role: 'user', content: userContent }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=1.0.abc; cc_entrypoint=cli; cch=00000;',
        },
      ],
    })

    expect(hasCchPlaceholder(body)).toBe(true)

    const replaced = replaceCchPlaceholder(body, 'abcde')
    const parsed = JSON.parse(replaced)

    expect(parsed.messages[0].content).toBe(userContent)
    expect(parsed.system[0].text).toContain('cch=abcde')
    expect(parsed.system[0].text).not.toContain('cch=00000')
  })

  test('ignores top-level string values named system', () => {
    const userContent =
      'result: x-anthropic-billing-header: cc_version=9; cch=00000;'
    const body = JSON.stringify({
      label: 'system',
      messages: [{ role: 'user', content: userContent }],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=1.0.abc; cc_entrypoint=cli; cch=00000;',
        },
      ],
    })

    const replaced = replaceCchPlaceholder(body, 'abcde')
    const parsed = JSON.parse(replaced)

    expect(parsed.messages[0].content).toBe(userContent)
    expect(parsed.system[0].text).toContain('cch=abcde')
    expect(parsed.system[0].text).not.toContain('cch=00000')
  })

  test('ignores header-like text outside the system prompt', () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'hello' }],
      system: [{ type: 'text', text: 'ordinary system prompt' }],
      tools: [
        {
          name: 'Debug',
          description: 'x-anthropic-billing-header: cc_version=9; cch=00000;',
        },
      ],
    })

    expect(hasCchPlaceholder(body)).toBe(false)
    expect(replaceCchPlaceholder(body, 'abcde')).toBe(body)
  })

  test('ignores nested system keys in tool inputs', () => {
    const userContent =
      'result: x-anthropic-billing-header: cc_version=9; cch=00000;'
    const body = JSON.stringify({
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu_1',
              name: 'Config',
              input: { system: 'default' },
            },
          ],
        },
        { role: 'user', content: userContent },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=1.0.abc; cc_entrypoint=cli; cch=00000;',
        },
      ],
    })

    const replaced = replaceCchPlaceholder(body, 'abcde')
    const parsed = JSON.parse(replaced)

    expect(parsed.messages[1].content).toBe(userContent)
    expect(parsed.system[0].text).toContain('cch=abcde')
    expect(parsed.system[0].text).not.toContain('cch=00000')
  })
})
