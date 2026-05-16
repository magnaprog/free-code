import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.literal('unimplemented'),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

// model receives this as a normal tool result (is_error: false).
// is_error: true caused the previous implementation to look like a tool
// failure each call, prompting retries. With is_error: false the model
// reads the informational status and learns not to call it again.
const MESSAGE =
  'ctx_inspect is currently unavailable: CONTEXT_COLLAPSE feature is compiled in but its runtime state is inactive. Do not call this tool until the feature reports active.'

export const CtxInspectTool = buildTool({
  name: 'ctx_inspect',
  searchHint: 'inspect context collapse state',
  maxResultSizeChars: 20_000,
  shouldDefer: true,
  async description() {
    return MESSAGE
  },
  async prompt() {
    return MESSAGE
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'CtxInspect'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async call() {
    return {
      data: {
        status: 'unimplemented' as const,
        message: MESSAGE,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const output = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.message,
      // not is_error. The status field carries the unimplemented
      // signal; the model should reason about the response rather than
      // treat it as a transient failure to retry.
      is_error: false,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
