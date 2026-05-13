import { feature } from 'bun:bundle'
import type { PartialCompactDirection } from '../../types/message.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Aggressive no-tools preamble. The cache-sharing fork path inherits the
// parent's full tool set (required for cache-key match), and on Sonnet 4.6+
// adaptive-thinking models the model sometimes attempts a tool call despite
// the weaker trailer instruction. With maxTurns: 1, a denied tool call means
// no text output → falls through to the streaming fallback (2.79% on 4.6 vs
// 0.01% on 4.5). Putting this FIRST and making it explicit about rejection
// consequences prevents the wasted turn.
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: one <summary> block only.
- Do NOT include <analysis>, scratchpad, chain-of-thought, or any text outside <summary>.

`

// Two variants: BASE scopes to "the conversation", PARTIAL scopes to "the
// recent messages". The model should reason internally; emitted scratchpad
// burns compact output budget before formatCompactSummary() can strip it.
const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, internally organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - short code snippets only when essential
     - function signatures
     - file edits
     - project-specific development environment setup, including required runtimes/toolchains, package managers, shell configuration, PATH changes, and environment variables
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, internally organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - short code snippets only when essential
     - function signatures
     - file edits
     - project-specific development environment setup, including required runtimes/toolchains, package managers, shell configuration, PATH changes, and environment variables
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`

const SUMMARY_OUTPUT_BUDGET_INSTRUCTION = `Output constraints:
- Return exactly one <summary> block and nothing else.
- Keep the summary under 8,000 tokens.
- Prefer concise bullets with exact file paths, function names, commands, errors, and decisions.
- Include code snippets only when essential and short; otherwise point to the transcript for full details.`

const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

${SUMMARY_OUTPUT_BUDGET_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include short code snippets only when essential, plus a brief note on why each file mattered.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Environment and workflow setup: Preserve the exact setup needed to continue work in this project, including runtimes, toolchains, package managers, shell configuration, PATH or tool availability, and required environment variables.
6. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
7. All user messages: List each user message that is not a tool result. Paraphrase long messages; quote exact wording only for short critical instructions.
8. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
9. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and short code snippets only when essential.
10. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important short snippet, if essential]
   - [File Name 2]
      - [Important short snippet, if essential]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Environment and workflow setup:
   [Exact development environment setup, successful commands, environment variables, and PATH/tool availability notes]

6. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

7. All user messages:
    - [Detailed non tool use user message]
    - [...]

8. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

9. Current Work:
   [Precise description of current work]

10. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. 

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

${SUMMARY_OUTPUT_BUDGET_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include short code snippets only when essential, plus a brief note on why each file mattered.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Environment and workflow setup: Preserve the exact setup needed to continue work in this project, including runtimes, toolchains, package managers, shell configuration, PATH or tool availability, and required environment variables.
6. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
7. All user messages: List each user message from the recent portion that is not a tool result. Paraphrase long messages; quote exact wording only for short critical instructions.
8. Pending Tasks: Outline any pending tasks from the recent messages.
9. Current Work: Describe precisely what was being worked on immediately before this summary request.
10. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important short snippet, if essential]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Environment and workflow setup:
   [Exact development environment setup, successful commands, environment variables, and PATH/tool availability notes]

6. Problem Solving:
   [Description]

7. All user messages:
    - [Detailed non tool use user message]

8. Pending Tasks:
   - [Task 1]

9. Current Work:
   [Precise description of current work]

10. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`

// 'up_to': model sees only the summarized prefix (cache hit). Summary will
// precede kept recent messages, hence "Context for Continuing Work" section.
const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

${SUMMARY_OUTPUT_BUDGET_INSTRUCTION}

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include short code snippets only when essential, plus a brief note on why each file mattered.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Environment and workflow setup: Preserve the exact setup needed to continue work in this project, including runtimes, toolchains, package managers, shell configuration, PATH or tool availability, and required environment variables.
6. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
7. All user messages: List each user message that is not a tool result. Paraphrase long messages; quote exact wording only for short critical instructions.
8. Pending Tasks: Outline any pending tasks.
9. Work Completed: Describe what was accomplished by the end of this portion.
10. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important short snippet, if essential]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Environment and workflow setup:
   [Exact development environment setup, successful commands, environment variables, and PATH/tool availability notes]

6. Problem Solving:
   [Description]

7. All user messages:
    - [Detailed non tool use user message]

8. Pending Tasks:
   - [Task 1]

9. Work Completed:
   [Description of what was accomplished]

10. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
`

const NO_TOOLS_TRAILER =
  '\n\nREMINDER: Do NOT call any tools. Respond with plain text only — ' +
  'one <summary> block and nothing else. ' +
  'Tool calls will be rejected and you will fail the task.'

const EMERGENCY_COMPACT_PROMPT = `EMERGENCY COMPACTION RETRY.

The previous compaction attempt exceeded the output-token limit. Produce a much shorter, lossy continuation summary.

{{scope}}

Hard requirements:
- Return exactly one <summary> block and nothing else.
- Stay under 4,000 tokens.
- No analysis, no preamble, no code blocks unless absolutely essential.
- Preserve only what is needed to continue work safely: active user request, changed files, commands/tests, errors, decisions, and next step.
- Omit routine transcript history, repeated reasoning, long file contents, and non-critical details.
- If details are too large, point to the transcript path instead of copying them.

<summary>
1. Active Request:
2. Critical Files/Changes:
3. Validation/Errors:
4. Current State:
5. Next Step:
</summary>`

export function getEmergencyCompactPrompt(
  customInstructions?: string,
  direction?: PartialCompactDirection,
): string {
  const scope = getEmergencyCompactScope(direction)
  let prompt =
    NO_TOOLS_PREAMBLE + EMERGENCY_COMPACT_PROMPT.replace('{{scope}}', scope)

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

function getEmergencyCompactScope(
  direction?: PartialCompactDirection,
): string {
  if (direction === 'from') {
    return 'Scope: summarize only the recent messages selected for partial compaction. Earlier messages are retained verbatim; do not duplicate them except for essential dependencies.'
  }
  if (direction === 'up_to') {
    return 'Scope: summarize only the older prefix you can see. Newer messages will be preserved after this summary; provide context needed to understand them.'
  }
  return 'Scope: summarize the conversation so far for continuation.'
}

export function getPartialCompactPrompt(
  customInstructions?: string,
  direction: PartialCompactDirection = 'from',
): string {
  const template =
    direction === 'up_to'
      ? PARTIAL_COMPACT_UP_TO_PROMPT
      : PARTIAL_COMPACT_PROMPT
  let prompt = NO_TOOLS_PREAMBLE + template

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}

/**
 * Formats the compact summary by stripping any accidental <analysis> scratchpad
 * and replacing <summary> XML tags with readable section headers.
 * @param summary The raw summary string potentially containing <analysis> and <summary> XML tags
 * @returns The formatted summary with analysis stripped and summary tags replaced by headers
 */
export function formatCompactSummary(summary: string): string {
  let formattedSummary = summary

  // Be tolerant of older/misbehaving summaries that still emit scratchpad text.
  formattedSummary = formattedSummary.replace(
    /<analysis>[\s\S]*?<\/analysis>/,
    '',
  )

  // Extract and format summary section
  const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch) {
    const content = summaryMatch[1] || ''
    formattedSummary = formattedSummary.replace(
      /<summary>[\s\S]*?<\/summary>/,
      `Summary:\n${content.trim()}`,
    )
  }

  // Clean up extra whitespace between sections
  formattedSummary = formattedSummary.replace(/\n\n+/g, '\n\n')

  return formattedSummary.trim()
}

export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\nRecent messages are preserved verbatim.`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`

    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive()
    ) {
      continuation += `

You are running in autonomous/proactive mode. This is NOT a first wake-up — you were already working autonomously before compaction. Continue your work loop: pick up where you left off based on the summary above. Do not greet the user or ask what to work on.`
    }

    return continuation
  }

  return baseSummary
}
