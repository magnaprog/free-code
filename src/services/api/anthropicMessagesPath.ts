/**
 * Classify a URL according to the Anthropic Messages API surface that
 * custom fetch adapters need to intercept.
 *
 * Background: the Anthropic SDK calls two endpoints under the same
 * `/v1/messages` prefix:
 *   1. `/v1/messages` — Messages create (the path adapters translate).
 *   2. `/v1/messages/count_tokens` — token counting (different body
 *      shape; must NOT be translated as generation, and must NOT be
 *      forwarded to the network from non-Anthropic adapters because
 *      that would POST prompt/tool content to `api.anthropic.com` or
 *      `ANTHROPIC_BASE_URL`, leaking it across the provider boundary).
 *
 * The SDK also supports path-prefixed base URLs (e.g.
 * `ANTHROPIC_BASE_URL=https://proxy.example/anthropic`), so the
 * pathname can be `/anthropic/v1/messages`. We match on the suffix
 * `/v1/messages`, not the full pathname.
 *
 * Returns:
 *   - 'create'        — translate to provider-native message endpoint.
 *   - 'count_tokens'  — adapter should respond locally; never forward.
 *   - 'other'         — pass through to globalThis.fetch (unrelated path).
 */
export type AnthropicMessagesRoute = 'create' | 'count_tokens' | 'other'

const COUNT_TOKENS_SUFFIX = '/v1/messages/count_tokens'
const CREATE_SUFFIX = '/v1/messages'

export function classifyAnthropicMessagesUrl(url: string): AnthropicMessagesRoute {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    // Relative or malformed URL — strip query/fragment manually and match
    // against the raw input as the pathname best-effort approximation.
    pathname = url.split('?')[0]!.split('#')[0]!
  }
  if (pathname.endsWith(COUNT_TOKENS_SUFFIX)) return 'count_tokens'
  if (pathname.endsWith(CREATE_SUFFIX)) return 'create'
  return 'other'
}

/**
 * Build a structured Anthropic-shaped error response signaling that
 * count_tokens is unavailable on this adapter. The SDK's
 * `countTokens()` throws on non-2xx and the caller in
 * `tokenEstimation.ts` catches and returns null, falling back to rough
 * estimation. No network traffic.
 */
export function countTokensUnsupportedResponse(): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: {
        type: 'not_found_error',
        message:
          'count_tokens is not supported by this provider adapter; ' +
          'fall back to rough token estimation.',
      },
    }),
    { status: 404, headers: { 'Content-Type': 'application/json' } },
  )
}
