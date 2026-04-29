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
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'literal cch=00000 value' }],
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

    expect(parsed.messages[0].content).toBe('literal cch=00000 value')
    expect(parsed.system[0].text).toContain('cch=abcde')
    expect(parsed.system[0].text).not.toContain('cch=00000')
  })
})
