import type { ContextData } from '../../utils/analyzeContext.js'
import { redactSecrets } from '../../utils/redaction.js'
import {
  formatCompactionConfigSummary,
  getCompactionConfig,
  getCompactionThresholds,
} from './compactionConfig.js'

export type TokenLedgerTopContributor = {
  kind:
    | 'message'
    | 'tool_result'
    | 'tool_schema'
    | 'attachment'
    | 'memory'
    | 'system'
  id?: string
  tokens: number
  description: string
}

export type TokenLedger = {
  modelContextWindow: number
  effectiveWindow: number
  outputReservation: number
  systemPromptTokens: number
  toolSchemaTokens: number
  messageTokens: number
  mediaTokens: number
  toolResultTokens: number
  estimatedTotalInputTokens: number
  threshold: {
    warn: number
    compact: number
    block: number
  }
  topContributors: TokenLedgerTopContributor[]
  configSummary: string
}

type BuildTokenLedgerInput = {
  data: Omit<ContextData, 'tokenLedger'>
  model: string
  modelContextWindow: number
  effectiveWindow: number
}

function categoryTokens(data: ContextData, predicate: (name: string) => boolean) {
  return data.categories
    .filter(cat => !cat.isDeferred && predicate(cat.name))
    .reduce((sum, cat) => sum + cat.tokens, 0)
}

function contributorKindForCategory(
  name: string,
): TokenLedgerTopContributor['kind'] {
  if (name === 'Messages') return 'message'
  if (name === 'Memory files') return 'memory'
  if (name === 'System prompt') return 'system'
  if (name.includes('tool') || name === 'MCP tools' || name === 'Skills') {
    return 'tool_schema'
  }
  return 'system'
}

function safeDescription(description: string): string {
  return redactSecrets(description).slice(0, 160)
}

export function buildTokenLedger({
  data,
  model,
  modelContextWindow,
  effectiveWindow,
}: BuildTokenLedgerInput): TokenLedger {
  const toolSchemaTokens = categoryTokens(
    data,
    name => name.includes('tool') || name === 'MCP tools' || name === 'Skills',
  )
  const messageTokens = categoryTokens(data, name => name === 'Messages')
  const messageBreakdown = data.messageBreakdown
  const thresholds = getCompactionThresholds(model)
  const config = getCompactionConfig(model)

  const contributors: TokenLedgerTopContributor[] = data.categories
    .filter(cat => !cat.isDeferred && cat.tokens > 0 && cat.name !== 'Free space')
    .map(cat => ({
      kind: contributorKindForCategory(cat.name),
      tokens: cat.tokens,
      description: safeDescription(cat.name),
    }))

  for (const tool of messageBreakdown?.toolCallsByType ?? []) {
    const total = tool.callTokens + tool.resultTokens
    if (total <= 0) continue
    contributors.push({
      kind: tool.resultTokens > tool.callTokens ? 'tool_result' : 'message',
      tokens: total,
      description: safeDescription(`tool:${tool.name}`),
    })
  }

  for (const attachment of messageBreakdown?.attachmentsByType ?? []) {
    if (attachment.tokens <= 0) continue
    contributors.push({
      kind: 'attachment',
      tokens: attachment.tokens,
      description: safeDescription(`attachment:${attachment.name}`),
    })
  }

  return {
    modelContextWindow,
    effectiveWindow,
    outputReservation: Math.max(0, modelContextWindow - effectiveWindow),
    systemPromptTokens: categoryTokens(data, name => name === 'System prompt'),
    toolSchemaTokens,
    messageTokens,
    mediaTokens: messageBreakdown?.attachmentTokens ?? 0,
    toolResultTokens: messageBreakdown?.toolResultTokens ?? 0,
    estimatedTotalInputTokens: data.totalTokens,
    threshold: thresholds,
    topContributors: contributors
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8),
    configSummary: formatCompactionConfigSummary(config),
  }
}
