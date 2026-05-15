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

const MESSAGE =
  'CONTEXT_COLLAPSE is compiled in but inactive in this build; ctx_inspect is unavailable.'

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
      is_error: true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
