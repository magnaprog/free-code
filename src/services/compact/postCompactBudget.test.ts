import { describe, expect, test } from 'bun:test'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { applyPostCompactAttachmentBudget } from './compact.js'

describe('post-compact attachment budget', () => {
  test('keeps required plan state and drops low-priority overflow', () => {
    const hugeDeferredTools = createAttachmentMessage({
      type: 'deferred_tools_delta',
      addedNames: ['huge-tool'],
      addedLines: ['huge-tool '.repeat(5000)],
      removedNames: [],
    })
    const plan = createAttachmentMessage({
      type: 'plan_file_reference',
      planFilePath: '/tmp/plan.md',
      planContent: 'required plan state',
    })

    const budgeted = applyPostCompactAttachmentBudget(
      [hugeDeferredTools, plan],
      100,
    )

    expect(budgeted.some(msg => msg.attachment.type === 'plan_file_reference')).toBe(
      true,
    )
    expect(budgeted.some(msg => msg.uuid === hugeDeferredTools.uuid)).toBe(false)
    expect(
      budgeted.some(msg => msg.attachment.type === 'critical_system_reminder'),
    ).toBe(true)
  })

  // B4: a single huge priority-≤1 attachment must not blow the bypass
  // ceiling (2 × budgetTokens). Cap is absolute.
  test('drops priority-<=1 attachment that exceeds bypass ceiling', () => {
    const hugePlan = createAttachmentMessage({
      type: 'plan_file_reference',
      planFilePath: '/tmp/huge-plan.md',
      // ~50K chars ≈ way more than 2 × budget=100 tokens.
      planContent: 'X'.repeat(50_000),
    })

    const budgeted = applyPostCompactAttachmentBudget([hugePlan], 100)

    // Plan dropped because it exceeded 2 × budget (200 tokens).
    expect(budgeted.some(msg => msg.attachment.type === 'plan_file_reference')).toBe(
      false,
    )
    // Truncation marker emitted; mentions the high-priority drop.
    const reminder = budgeted.find(
      msg => msg.attachment.type === 'critical_system_reminder',
    )
    expect(reminder).toBeDefined()
  })

  // B4: priority-≤1 attachment under the bypass ceiling is kept even when
  // it exceeds the regular budget.
  test('keeps priority-<=1 attachment under bypass ceiling but over budget', () => {
    // budget=1000, ceiling=2*1000=2000.
    // Plan content 5000 chars ≈ 1250 tokens → over budget, under ceiling.
    const moderatePlan = createAttachmentMessage({
      type: 'plan_file_reference',
      planFilePath: '/tmp/mid-plan.md',
      planContent: 'Y'.repeat(5000),
    })

    const budgeted = applyPostCompactAttachmentBudget([moderatePlan], 1000)

    expect(budgeted.some(msg => msg.attachment.type === 'plan_file_reference')).toBe(
      true,
    )
  })
})
