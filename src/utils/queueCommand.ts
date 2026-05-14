const QUEUE_COMMAND_RE = /^\s*\/queue(?=$|\s)([\s\S]*)$/

export function formatQueueCommand(payload: string): string {
  return payload.length > 0 ? `/queue ${payload}` : '/queue'
}

export function parseQueueCommand(input: string): string | null {
  const match = QUEUE_COMMAND_RE.exec(input)
  if (!match) return null

  const payload = match[1] ?? ''
  const withoutLeadingInlineWhitespace = payload.replace(/^[^\S\r\n]+/, '')
  if (withoutLeadingInlineWhitespace.startsWith('\r\n')) {
    return withoutLeadingInlineWhitespace.slice(2)
  }
  if (
    withoutLeadingInlineWhitespace.startsWith('\n') ||
    withoutLeadingInlineWhitespace.startsWith('\r')
  ) {
    return withoutLeadingInlineWhitespace.slice(1)
  }
  return withoutLeadingInlineWhitespace
}
