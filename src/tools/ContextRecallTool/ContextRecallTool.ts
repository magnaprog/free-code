import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  searchArtifacts,
  type ArtifactSearchInput,
  type ArtifactSearchResult,
} from '../../services/context/ArtifactIndex.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'

const artifactKindSchema = z.enum([
  'tool_result',
  'transcript',
  'transcript_range',
  'summary',
  'checkpoint',
])

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .optional()
      .describe('Text to search for in artifact metadata and previews.'),
    filePath: z
      .string()
      .optional()
      .describe('Filter artifacts whose stored path contains this path.'),
    toolName: z
      .string()
      .optional()
      .describe('Filter persisted tool-result artifacts by exact tool name.'),
    kind: artifactKindSchema
      .optional()
      .describe(
        'Artifact kind to search. "transcript" aliases transcript_range.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(5)
      .describe('Maximum result count, capped at 20.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputArtifactSchema = z.object({
  kind: z.enum(['tool_result', 'transcript_range', 'summary', 'checkpoint']),
  id: z.string(),
  path: z.string(),
  createdAt: z.string(),
  score: z.number(),
  toolUseId: z.string().optional(),
  toolName: z.string().optional(),
  sha256: z.string().optional(),
  bytes: z.number().optional(),
  preview: z.string().optional(),
  startUuid: z.string().optional(),
  endUuid: z.string().optional(),
  compactId: z.string().optional(),
  snippet: z.string().optional(),
  missing: z.boolean().optional(),
})

const outputSchema = lazySchema(() =>
  z.object({
    results: z.array(outputArtifactSchema),
    corruptLines: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function formatArtifactResult(result: ArtifactSearchResult): Output['results'][number] {
  const ref = result.ref
  const base = {
    kind: ref.kind,
    id: ref.id,
    path: ref.path,
    createdAt: ref.createdAt,
    score: result.score,
    ...(result.snippet !== undefined ? { snippet: result.snippet } : {}),
    ...(result.missing ? { missing: true } : {}),
  }

  switch (ref.kind) {
    case 'tool_result':
      return {
        ...base,
        toolUseId: ref.toolUseId,
        toolName: ref.toolName,
        sha256: ref.sha256,
        bytes: ref.bytes,
        preview: ref.preview,
      }
    case 'transcript_range':
      return {
        ...base,
        startUuid: ref.startUuid,
        endUuid: ref.endUuid,
      }
    case 'summary':
    case 'checkpoint':
      return {
        ...base,
        compactId: ref.compactId,
      }
  }
}

function toSearchInput(input: Input): ArtifactSearchInput {
  return {
    query: input.query,
    filePath: input.filePath,
    toolName: input.toolName,
    kind: input.kind,
    limit: input.limit,
  }
}

export async function searchContextArtifacts(
  input: Input,
  indexPath?: string,
): Promise<Output> {
  const { results, corruptLines } = await searchArtifacts({
    ...toSearchInput(input),
    indexPath,
  })
  return {
    results: results.map(formatArtifactResult),
    corruptLines,
  }
}

const PROMPT = `Searches this session's context artifact index for persisted tool results, transcript ranges, compact summaries, and checkpoints.

Use this after compaction or tool-result persistence when details may have been removed from the prompt but saved as an artifact. Filters are ANDed. Returned snippets are capped and redacted.`

export const ContextRecallTool = buildTool({
  name: 'context_recall',
  searchHint: 'search recalled context artifacts and persisted tool results',
  maxResultSizeChars: 120_000,
  shouldDefer: true,
  strict: true,
  async description() {
    return PROMPT
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return 'Context Recall'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return [input.query, input.filePath, input.toolName, input.kind]
      .filter(Boolean)
      .join(' ')
  },
  getToolUseSummary(input) {
    return input?.query ?? input?.filePath ?? input?.toolName ?? null
  },
  getActivityDescription() {
    return 'Searching context artifacts'
  },
  async call(input: Input) {
    return { data: await searchContextArtifacts(input) }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content, null, 2),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
