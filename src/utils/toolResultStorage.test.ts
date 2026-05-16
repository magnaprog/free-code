import { describe, expect, test } from 'bun:test'
import {
  estimateBase64DecodedBytes,
  reserveMcpBinaryBytes,
} from './mcpOutputStorage.js'
import {
  safeFilenameFromToolUseId,
  sanitizeToolResultId,
} from './toolResultStorage.js'

describe('sanitizeToolResultId', () => {
  // Codex follow-up: path traversal defense for tool_use_id used as
  // filename component. Provider-controlled IDs cannot escape the
  // tool-results directory via `..` or path separators. The sanitizer
  // does not need to remove EVERY non-allowed character meaningfully —
  // it just needs to make any join() with the tool-results dir stay
  // inside that dir. Leading dots become `_` so `.` and `..` cannot
  // collide with parent directories. Path separators become `_` so
  // embedded `..` cannot escape via `dir/.._dir/file` patterns either.
  test('replaces path separators with underscore', () => {
    expect(sanitizeToolResultId('foo/bar')).toBe('foo_bar')
    expect(sanitizeToolResultId('foo\\bar')).toBe('foo_bar')
    expect(sanitizeToolResultId('a/b/c')).toBe('a_b_c')
  })

  test('replaces leading dots so `.` and `..` never match parent dirs', () => {
    // Single dot stripped.
    expect(sanitizeToolResultId('.')).toBe('_')
    // Two dots stripped (leading run replaced with single _).
    expect(sanitizeToolResultId('..')).toBe('_')
    // Leading dots + slash + rest. `..` -> single `_`, `/` -> `_`.
    expect(sanitizeToolResultId('../escape')).toBe('__escape')
    // Multiple dots and slashes: leading dots collapsed to single `_`;
    // embedded slashes become `_`. Result keeps the embedded `..` but
    // that is safe: join() with the tool-results dir produces
    // `dir/__.._etc_passwd` — a single filename inside the dir, not a
    // traversal because no path separator survives.
    expect(sanitizeToolResultId('../../etc/passwd')).toBe('__.._etc_passwd')
  })

  test('preserves normal tool_use ID shapes', () => {
    expect(sanitizeToolResultId('toolu_01ABC123xyz')).toBe('toolu_01ABC123xyz')
    expect(sanitizeToolResultId('call_xyz_123')).toBe('call_xyz_123')
    expect(sanitizeToolResultId('mcp-server-tool-12345')).toBe('mcp-server-tool-12345')
  })

  test('falls back to random UUID when input becomes empty after sanitization', () => {
    // Empty input → fallback (the cleaned/safe pipeline produces empty
    // string when the only chars were stripped to nothing). The
    // current allowlist keeps `_` for non-alphanumeric, so this guard
    // mostly fires on the empty-string case rather than via stripping.
    const result = sanitizeToolResultId('')
    expect(result.startsWith('toolu_anon_')).toBe(true)
  })
})

describe('MCP binary output budget', () => {
  test('estimates base64 decoded bytes before decoding', () => {
    expect(estimateBase64DecodedBytes('')).toBe(0)
    expect(estimateBase64DecodedBytes('TQ==')).toBe(1)
    expect(estimateBase64DecodedBytes('TWE=')).toBe(2)
    expect(estimateBase64DecodedBytes('TWFu')).toBe(3)
    expect(estimateBase64DecodedBytes('T W\nF u')).toBe(3)
  })

  test('reserves an aggregate budget across MCP binary blobs', () => {
    const budget = { usedBytes: 25 * 1024 * 1024 - 1 }

    expect(reserveMcpBinaryBytes('TQ==', budget, '')).toEqual({ ok: true })
    const rejected = reserveMcpBinaryBytes('TQ==', budget, '')

    expect(rejected.ok).toBe(false)
    if (!rejected.ok) {
      expect(rejected.message).toContain('omitted')
      expect(rejected.message).toContain('25MB')
    }
  })
})

describe('safeFilenameFromToolUseId', () => {
  // Round 8: distinct raw IDs must produce distinct filenames even when
  // the sanitizer alone would collapse them. Without this, persistToolResult's
  // `wx + EEXIST = success` behavior would silently alias the second
  // write to the first file's content (data corruption).
  test('distinct IDs that collapse under sanitization map to distinct filenames', () => {
    const a = safeFilenameFromToolUseId('a/b')
    const b = safeFilenameFromToolUseId('a:b')
    const c = safeFilenameFromToolUseId('a\\b')
    const d = safeFilenameFromToolUseId('a;b')
    // Sanitizer alone: all four → 'a_b'. Hash suffix keeps them distinct.
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(c).not.toBe(d)
    expect(a).not.toBe(d)
  })

  test('same raw ID always produces the same filename (replay idempotent)', () => {
    expect(safeFilenameFromToolUseId('toolu_01ABC')).toBe(
      safeFilenameFromToolUseId('toolu_01ABC'),
    )
    expect(safeFilenameFromToolUseId('mcp-server-tool-xyz')).toBe(
      safeFilenameFromToolUseId('mcp-server-tool-xyz'),
    )
  })

  test('preserves readable sanitized prefix before the hash suffix', () => {
    const name = safeFilenameFromToolUseId('toolu_01ABC')
    // Prefix is the sanitizer output truncated to ≤32 chars; then `-`;
    // then 11 base64url hash chars. So the name starts with the
    // sanitized prefix.
    expect(name.startsWith('toolu_01ABC-')).toBe(true)
  })

  test('truncates very long IDs but keeps them distinct via hash', () => {
    const long = 'a'.repeat(100)
    const longPlusOne = 'a'.repeat(100) + 'b'
    const name1 = safeFilenameFromToolUseId(long)
    const name2 = safeFilenameFromToolUseId(longPlusOne)
    // Prefix is capped at 32 chars so the prefixes match; the hash
    // suffix differs.
    expect(name1).not.toBe(name2)
  })

  test('hash suffix is filesystem-safe (no /, +, =, or path chars)', () => {
    const name = safeFilenameFromToolUseId('any-input-value-here')
    // base64url uses [A-Za-z0-9_-]; no /, +, = expected.
    expect(name).not.toContain('/')
    expect(name).not.toContain('+')
    expect(name).not.toContain('=')
  })

  // Round 9: empty raw ID must be deterministic. The sanitizer alone
  // returns a random UUID prefix for '', which would break the replay-
  // idempotency invariant. safeFilenameFromToolUseId routes empty input
  // through a fixed prefix instead.
  test('empty raw ID produces deterministic filename (replay idempotent)', () => {
    expect(safeFilenameFromToolUseId('')).toBe(safeFilenameFromToolUseId(''))
    expect(safeFilenameFromToolUseId('').startsWith('toolu_anon_empty-')).toBe(
      true,
    )
  })
})
