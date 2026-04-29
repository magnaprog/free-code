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

export function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecretValues)
  }

  if (value && typeof value === 'object' && isPlainObject(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = isSecretKey(key)
        ? REDACTED
        : redactSecretValues(nestedValue)
    }
    return result
  }

  return value
}

export function redactSecrets(input: string): string {
  return input
    .replace(
      /("([^"\\]|\\.)*(?:token|secret|authorization|cookie|api[_-]?key|assertion|device[_-]?code)([^"\\]|\\.)*"\s*:\s*)"([^"\\]|\\.)*"/gi,
      `$1"${REDACTED}"`,
    )
    .replace(/\bBearer\s+[-._~+/A-Za-z0-9]+=*/gi, `Bearer ${REDACTED}`)
    .replace(
      /(^|[?&\s])((?:access_token|refresh_token|id_token|client_secret|device_code|code|state)=)[^&#\s]+/gi,
      `$1$2${REDACTED}`,
    )
}
