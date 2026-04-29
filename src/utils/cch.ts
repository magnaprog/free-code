import xxhash from 'xxhash-wasm'

const CCH_SEED = 0x6E52736AC806831En
const CCH_PLACEHOLDER = 'cch=00000'
const BILLING_HEADER_KEY = 'x-anthropic-billing-header'
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

function findBillingHeaderPlaceholder(body: string): number {
  const headerStart = body.indexOf(BILLING_HEADER_KEY)
  if (headerStart === -1) return -1
  return body.indexOf(CCH_PLACEHOLDER, headerStart)
}

export function replaceCchPlaceholder(body: string, cch: string): string {
  const placeholderIndex = findBillingHeaderPlaceholder(body)
  if (placeholderIndex === -1) return body
  return `${body.slice(0, placeholderIndex)}cch=${cch}${body.slice(placeholderIndex + CCH_PLACEHOLDER.length)}`
}

export function hasCchPlaceholder(body: string): boolean {
  return findBillingHeaderPlaceholder(body) !== -1
}
