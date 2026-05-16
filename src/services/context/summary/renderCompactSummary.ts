import type {
  CompactSummary,
  EmergencyCompactSummary,
} from './CompactSummarySchema.js'

export function renderCompactSummary(
  summary: CompactSummary | EmergencyCompactSummary,
): string {
  if ('primaryRequest' in summary) return renderFullCompactSummary(summary)
  return renderEmergencyCompactSummary(summary)
}

function renderFullCompactSummary(summary: CompactSummary): string {
  const lines: string[] = []
  lines.push('Summary:')
  lines.push('')
  lines.push('1. Primary Request and Intent:')
  lines.push(summary.primaryRequest)
  lines.push('')
  lines.push('2. Active Task:')
  lines.push(summary.activeTask)
  appendList(lines, '3. Hard Constraints:', summary.hardConstraints)
  appendList(lines, '4. User Preferences:', summary.userPreferences)
  appendList(
    lines,
    '5. Files and Code Sections:',
    summary.files.map(file => {
      const facts = file.facts.length > 0 ? ` — ${file.facts.join('; ')}` : ''
      const state = file.latestKnownState ? ` Latest: ${file.latestKnownState}` : ''
      return `${file.path} (${file.role})${facts}${state}`
    }),
  )
  appendList(
    lines,
    '6. Commands:',
    summary.commands.map(command =>
      [
        command.cwd ? `${command.cwd}$ ${command.command}` : command.command,
        command.outcome,
        command.importantOutput,
      ]
        .filter(Boolean)
        .join(' — '),
    ),
  )
  appendList(
    lines,
    '7. Errors and Fixes:',
    summary.errors.map(error =>
      [error.symptom, error.cause, error.fixAttempted, error.status]
        .filter(Boolean)
        .join(' — '),
    ),
  )
  appendList(
    lines,
    '8. Decisions:',
    summary.decisions.map(decision =>
      decision.rationale
        ? `${decision.decision} — ${decision.rationale}`
        : decision.decision,
    ),
  )
  appendList(
    lines,
    '9. Tests:',
    summary.tests.map(test =>
      [test.command, test.result, test.notes].filter(Boolean).join(' — '),
    ),
  )
  appendList(
    lines,
    '10. Plan:',
    summary.plan.map(item => `${item.status}: ${item.item}`),
  )
  appendList(
    lines,
    '11. Artifact References:',
    summary.artifactRefs.map(ref =>
      [ref.kind, ref.id, ref.path, ref.summary].filter(Boolean).join(' — '),
    ),
  )
  appendList(lines, '12. Do Not Forget:', summary.doNotForget)
  lines.push('')
  lines.push('13. Next Action:')
  lines.push(summary.nextAction)
  lines.push('')
  lines.push('Source Range:')
  lines.push(
    `${summary.sourceRange.startUuid}..${summary.sourceRange.endUuid}${summary.sourceRange.transcriptPath ? ` (${summary.sourceRange.transcriptPath})` : ''}`,
  )
  return lines.join('\n').trim()
}

function renderEmergencyCompactSummary(summary: EmergencyCompactSummary): string {
  const lines: string[] = []
  lines.push('Summary:')
  lines.push('')
  lines.push('1. Active Task:')
  lines.push(summary.activeTask)
  appendList(lines, '2. Hard Constraints:', summary.hardConstraints)
  appendList(lines, '3. Changed Files:', summary.changedFiles)
  appendList(lines, '4. Failing Tests:', summary.failingTests)
  appendList(
    lines,
    '5. Artifact References:',
    summary.artifactRefs.map(ref => `${ref.id} — ${ref.summary}`),
  )
  lines.push('')
  lines.push('6. Next Action:')
  lines.push(summary.nextAction)
  return lines.join('\n').trim()
}

function appendList(lines: string[], heading: string, items: string[]): void {
  lines.push('')
  lines.push(heading)
  if (items.length === 0) {
    lines.push('- none')
    return
  }
  for (const item of items) lines.push(`- ${item}`)
}
