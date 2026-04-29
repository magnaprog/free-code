import xxhash from 'xxhash-wasm'

const CCH_SEED = 0x6E52736AC806831En
const CCH_PLACEHOLDER = 'cch=00000'
const BILLING_HEADER_KEY = 'x-anthropic-billing-header'
const SYSTEM_PROPERTY = '"system"'
const CCH_MASK = 0xFFFFFn

let hasherPromise: ReturnType<typeof xxhash> | null = null

function getHasher() {
  if (!hasherPromise) {
    hasherPromise = xxhash()
  }
  return hasherPromise
}

export async function computeCch(body: string): Promise<string> {
  const hasher = await getHasher()
  const hash = hasher.h64Raw(new TextEncoder().encode(body), CCH_SEED)
  return (hash & CCH_MASK).toString(16).padStart(5, '0')
}

function findJsonValueEnd(body: string, start: number): number {
  const first = body[start]
  if (first === undefined) return -1

  if (first === '"') {
    let escaped = false
    for (let i = start + 1; i < body.length; i++) {
      const char = body[i]
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        return i + 1
      }
    }
    return -1
  }

  if (first === '{' || first === '[') {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < body.length; i++) {
      const char = body[i]

      if (inString) {
        if (escaped) {
          escaped = false
        } else if (char === '\\') {
          escaped = true
        } else if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
      } else if (char === '{' || char === '[') {
        depth++
      } else if (char === '}' || char === ']') {
        depth--
        if (depth === 0) return i + 1
      }
    }
    return -1
  }

  for (let i = start; i < body.length; i++) {
    const char = body[i]
    if (char === ',' || char === '}' || char === ']') return i
  }
  return body.length
}

function findTopLevelSystemValueRange(
  body: string,
): { start: number; end: number } | null {
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < body.length; i++) {
    const char = body[i]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      if (depth === 1 && body.startsWith(SYSTEM_PROPERTY, i)) {
        let prev = i - 1
        while (prev >= 0 && /\s/.test(body[prev]!)) prev--

        let colon = i + SYSTEM_PROPERTY.length
        while (colon < body.length && /\s/.test(body[colon]!)) colon++

        if ((body[prev] === '{' || body[prev] === ',') && body[colon] === ':') {
          let valueStart = colon + 1
          while (valueStart < body.length && /\s/.test(body[valueStart]!)) {
            valueStart++
          }
          const valueEnd = findJsonValueEnd(body, valueStart)
          if (valueEnd === -1) return null
          return { start: valueStart, end: valueEnd }
        }
      }
      inString = true
      continue
    }

    if (char === '{' || char === '[') {
      depth++
    } else if (char === '}' || char === ']') {
      depth--
    }
  }

  return null
}

function findBillingHeaderPlaceholder(body: string): number {
  const systemRange = findTopLevelSystemValueRange(body)
  if (!systemRange) return -1

  const headerStart = body.indexOf(BILLING_HEADER_KEY, systemRange.start)
  if (headerStart === -1 || headerStart >= systemRange.end) return -1

  const placeholderIndex = body.indexOf(CCH_PLACEHOLDER, headerStart)
  if (
    placeholderIndex === -1 ||
    placeholderIndex + CCH_PLACEHOLDER.length > systemRange.end
  ) {
    return -1
  }
  return placeholderIndex
}

export function replaceCchPlaceholder(body: string, cch: string): string {
  const placeholderIndex = findBillingHeaderPlaceholder(body)
  if (placeholderIndex === -1) return body
  return `${body.slice(0, placeholderIndex)}cch=${cch}${body.slice(placeholderIndex + CCH_PLACEHOLDER.length)}`
}

export function hasCchPlaceholder(body: string): boolean {
  return findBillingHeaderPlaceholder(body) !== -1
}
