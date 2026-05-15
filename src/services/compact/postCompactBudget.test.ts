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
})
