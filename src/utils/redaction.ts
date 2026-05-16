const SECRET_KEYS = new Set([
  'token',
  'secret',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'clientsecret',
  'devicecode',
  'sessioningresstoken',
  'sessiontoken',
  'environmentsecret',
  'assertion',
  'subjecttoken',
])

const REDACTED = '[REDACTED]'
const TRUNCATED_MARKER_PATTERN = /…\[truncated after \d+ bytes\]$/

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return (
    SECRET_KEYS.has(normalized) ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('apikey') ||
    normalized.startsWith('authorization') ||
    normalized.startsWith('cookie') ||
    normalized.startsWith('setcookie')
  )
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function redactSecretValuesInternal(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    return value.map(item => redactSecretValuesInternal(item, seen))
  }

  if (value && typeof value === 'object' && isPlainObject(value)) {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = isSecretKey(key)
        ? REDACTED
        : redactSecretValuesInternal(nestedValue, seen)
    }
    return result
  }

  return value
}

export function redactSecretValues(value: unknown): unknown {
  return redactSecretValuesInternal(value, new WeakSet<object>())
}

function decodeJsonStringLiteral(value: string): string {
  try {
    return JSON.parse(`"${value}"`)
  } catch {
    return value
  }
}

export function redactSecrets(input: string): string {
  return input
    .replace(
      /("((?:[^"\\]|\\.)*)"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
      (match: string, prefix: string, key: string) =>
        isSecretKey(decodeJsonStringLiteral(key)) ? `${prefix}"${REDACTED}"` : match,
    )
    .replace(
      /("((?:[^"\\]|\\.)*)"\s*:\s*)"((?:[^"\\]|\\.)*)$/g,
      (match: string, prefix: string, key: string) => {
        if (!isSecretKey(decodeJsonStringLiteral(key))) return match
        const marker = match.match(TRUNCATED_MARKER_PATTERN)?.[0] ?? ''
        return `${prefix}"${REDACTED}"${marker}`
      },
    )
    .replace(/\bBearer\s+[-._~+/A-Za-z0-9]+=*/gi, `Bearer ${REDACTED}`)
    .replace(
      /(^|[?&\s])((?:access_token|refresh_token|id_token|client_secret|device_code|code|state)=)[^&#\s]+/gi,
      `$1$2${REDACTED}`,
    )
}
