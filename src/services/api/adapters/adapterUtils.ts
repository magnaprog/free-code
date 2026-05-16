export const MAX_PROVIDER_ERROR_BODY_BYTES = 4096

export async function readProviderErrorBody(
  response: Response,
  maxBytes = MAX_PROVIDER_ERROR_BODY_BYTES,
): Promise<string> {
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  let truncated = false

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - bytesRead
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining))
        bytesRead += remaining
        truncated = true
        await reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      bytesRead += value.byteLength
    }

    if (!truncated && bytesRead >= maxBytes) {
      truncated = true
      await reader.cancel().catch(() => {})
    }
  } catch {
    truncated = true
    await reader.cancel().catch(() => {})
  } finally {
    reader.releaseLock()
  }

  const text = new TextDecoder().decode(concatChunks(chunks, bytesRead))
  return truncated ? `${text}…[truncated after ${maxBytes} bytes]` : text
}

function concatChunks(chunks: Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
