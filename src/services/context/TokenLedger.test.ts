import { describe, expect, test } from 'bun:test'
import type { ContextData } from '../../utils/analyzeContext.js'
import { buildTokenLedger } from './TokenLedger.js'

function contextData(): Omit<ContextData, 'tokenLedger'> {
  return {
    categories: [
      { name: 'System prompt', tokens: 1000, color: 'promptBorder' },
      { name: 'System tools', tokens: 2000, color: 'inactive' },
      { name: 'Messages', tokens: 3000, color: 'purple_FOR_SUBAGENTS_ONLY' },
      { name: 'Free space', tokens: 194000, color: 'promptBorder' },
    ],
    totalTokens: 6000,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 3,
    gridRows: [],
    model: 'test-model',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    messageBreakdown: {
      toolCallTokens: 100,
      toolResultTokens: 2500,
      attachmentTokens: 400,
      assistantMessageTokens: 300,
      userMessageTokens: 200,
      toolCallsByType: [
        {
          name: 'Bash Authorization: Bearer sk-secret',
          callTokens: 100,
          resultTokens: 2500,
        },
      ],
      attachmentsByType: [{ name: 'image', tokens: 400 }],
    },
    apiUsage: null,
  }
}

describe('TokenLedger', () => {
  test('wraps context data without a second estimator', () => {
    const ledger = buildTokenLedger({
      data: contextData(),
      model: 'test-model',
      modelContextWindow: 200000,
      effectiveWindow: 180000,
    })

    expect(ledger.estimatedTotalInputTokens).toBe(6000)
    expect(ledger.systemPromptTokens).toBe(1000)
    expect(ledger.toolSchemaTokens).toBe(2000)
    expect(ledger.messageTokens).toBe(3000)
    expect(ledger.toolResultTokens).toBe(2500)
    expect(ledger.mediaTokens).toBe(400)
    expect(ledger.outputReservation).toBe(20000)
  })

  test('redacts contributor descriptions', () => {
    const ledger = buildTokenLedger({
      data: contextData(),
      model: 'test-model',
      modelContextWindow: 200000,
      effectiveWindow: 180000,
    })

    const descriptions = ledger.topContributors
      .map(contributor => contributor.description)
      .join('\n')

    expect(descriptions).not.toContain('sk-secret')
    expect(descriptions).toContain('Bearer [REDACTED]')
  })
})
