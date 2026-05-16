import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { ensureConnectedClient } from '../../services/mcp/client.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getBinaryBlobSavedMessage,
  type McpBinaryBudget,
  persistBinaryContent,
  reserveMcpBinaryBytes,
} from '../../utils/mcpOutputStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  userFacingName,
} from './UI.js'

export const inputSchema = lazySchema(() =>
  z.object({
    server: z.string().describe('The MCP server name'),
    uri: z.string().describe('The resource URI to read'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

export const outputSchema = lazySchema(() =>
  z.object({
    contents: z.array(
      z.object({
        uri: z.string().describe('Resource URI'),
        mimeType: z.string().optional().describe('MIME type of the content'),
        text: z.string().optional().describe('Text content of the resource'),
        blobSavedTo: z
          .string()
          .optional()
          .describe('Path where binary blob content was saved'),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ReadMcpResourceTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.server} ${input.uri}`
  },
  shouldDefer: true,
  name: 'ReadMcpResourceTool',
  searchHint: 'read a specific MCP resource by URI',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients } }) {
    const { server: serverName, uri } = input

    const client = mcpClients.find(client => client.name === serverName)

    if (!client) {
      throw new Error(
        `Server "${serverName}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    if (client.type !== 'connected') {
      throw new Error(`Server "${serverName}" is not connected`)
    }

    if (!client.capabilities?.resources) {
      throw new Error(`Server "${serverName}" does not support resources`)
    }

    const connectedClient = await ensureConnectedClient(client)
    const result = (await connectedClient.client.request(
      {
        method: 'resources/read',
        params: { uri },
      },
      ReadResourceResultSchema,
    )) as ReadResourceResult

    // Intercept blob fields before they enter context as base64.
    const binaryBudget: McpBinaryBudget = { usedBytes: 0 }
    const contents: Output['contents'] = []
    for (const [i, c] of result.contents.entries()) {
      if ('text' in c) {
        contents.push({ uri: c.uri, mimeType: c.mimeType, text: c.text })
        continue
      }
      if (!('blob' in c) || typeof c.blob !== 'string') {
        contents.push({ uri: c.uri, mimeType: c.mimeType })
        continue
      }
      const prefix = `[Resource from ${serverName} at ${c.uri}] `
      const reserved = reserveMcpBinaryBytes(c.blob, binaryBudget, prefix)
      if (!reserved.ok) {
        contents.push({ uri: c.uri, mimeType: c.mimeType, text: reserved.message })
        continue
      }
      const persistId = `mcp-resource-${Date.now()}-${i}-${randomUUID()}`
      const persisted = await persistBinaryContent(
        Buffer.from(c.blob, 'base64'),
        c.mimeType,
        persistId,
      )
      if ('error' in persisted) {
        contents.push({
          uri: c.uri,
          mimeType: c.mimeType,
          text: `Binary content could not be saved to disk: ${persisted.error}`,
        })
        continue
      }
      contents.push({
        uri: c.uri,
        mimeType: c.mimeType,
        blobSavedTo: persisted.filepath,
        text: getBinaryBlobSavedMessage(
          persisted.filepath,
          c.mimeType,
          persisted.size,
          prefix,
        ),
      })
    }

    return {
      data: { contents },
    }
  },
  renderToolUseMessage,
  userFacingName,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
