import { describe, expect, test } from 'bun:test'
import { sanitizeToolResultId } from './toolResultStorage.js'

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
