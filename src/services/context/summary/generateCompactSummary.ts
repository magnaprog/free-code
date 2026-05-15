import type { PartialCompactDirection } from '../../../types/message.js'

const STRUCTURED_JSON_RULES = `Return plain JSON only. Do not wrap it in markdown, XML, or code fences. No commentary.
Use schemaVersion: 1. Preserve exact file paths, commands, errors, user constraints, current task, and next action. Use empty arrays when a category is absent.`

export function getStructuredCompactPrompt(customInstructions?: string): string {
  return withCustomInstructions(
    `${STRUCTURED_JSON_RULES}

Create a JSON compact summary with this exact shape:
{
  "schemaVersion": 1,
  "sourceRange": { "startUuid": "unknown", "endUuid": "unknown", "transcriptPath": "optional" },
  "primaryRequest": "...",
  "activeTask": "...",
  "hardConstraints": [],
  "userPreferences": [],
  "files": [{ "path": "...", "role": "read|modified|created|deleted|mentioned|test|config", "facts": [], "latestKnownState": "optional" }],
  "commands": [{ "command": "...", "cwd": "optional", "outcome": "...", "importantOutput": "optional" }],
  "errors": [{ "symptom": "...", "cause": "optional", "fixAttempted": "optional", "status": "resolved|unresolved|unknown" }],
  "decisions": [{ "decision": "...", "rationale": "optional" }],
  "tests": [{ "command": "...", "result": "pass|fail|not_run|partial|unknown", "notes": "optional" }],
  "plan": [{ "item": "...", "status": "todo|doing|done|blocked" }],
  "nextAction": "...",
  "artifactRefs": [{ "kind": "...", "id": "...", "path": "optional", "summary": "..." }],
  "doNotForget": []
}`,
    customInstructions,
  )
}

export function getStructuredEmergencyCompactPrompt(
  customInstructions?: string,
  direction?: PartialCompactDirection,
): string {
  return withCustomInstructions(
    `${STRUCTURED_JSON_RULES}

Emergency compact mode. Keep this short and lossy. ${getScope(direction)}

Create a JSON emergency compact summary with this exact shape:
{
  "schemaVersion": 1,
  "activeTask": "...",
  "hardConstraints": [],
  "changedFiles": [],
  "failingTests": [],
  "nextAction": "...",
  "artifactRefs": [{ "id": "...", "summary": "..." }]
}`,
    customInstructions,
  )
}

export function getStructuredPartialCompactPrompt(
  customInstructions?: string,
  direction?: PartialCompactDirection,
): string {
  return withCustomInstructions(
    `${STRUCTURED_JSON_RULES}

Create a JSON compact summary for the selected ${direction === 'up_to' ? 'older prefix' : 'recent portion'} only. Do not duplicate retained messages except for critical dependencies.

Use the full compact summary schema from the normal structured compact prompt.`,
    customInstructions,
  )
}

function getScope(direction?: PartialCompactDirection): string {
  if (direction === 'from') {
    return 'Summarize only recent messages; earlier messages are retained verbatim.'
  }
  if (direction === 'up_to') {
    return 'Summarize only the older prefix; newer messages will be retained after this summary.'
  }
  return 'Summarize the conversation so far for continuation.'
}

function withCustomInstructions(prompt: string, customInstructions?: string): string {
  if (!customInstructions?.trim()) return prompt
  return `${prompt}\n\nAdditional Instructions:\n${customInstructions}`
}
