import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  isSameQueueSchedulingBucket,
  peek,
} from './messageQueueManager.js'

type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

type ProcessQueueResult = {
  processed: boolean
}

/**
 * Check if a queued command is a slash command (value starts with '/').
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (typeof cmd.value === 'string') {
    return cmd.value.trim().startsWith('/')
  }
  // For ContentBlockParam[], check the first text block
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return block.text.trim().startsWith('/')
    }
  }
  return false
}

/**
 * Processes commands from the queue.
 *
 * User-facing commands (prompts, bash, slash) are drained ONE at a time so
 * still-queued items remain anchored in the prompt-area preview between
 * turns. Without this, batching collapsed every queued follow-up into a
 * single turn the moment the task ended — all queued messages "expanded"
 * into the message flow at once instead of staying compact at the bottom.
 *
 * Task notifications are still batched by scheduling bucket: multiple
 * agent completions arriving in the same tick should land as one turn,
 * not N consecutive LLM calls.
 *
 * The caller is responsible for ensuring no query is currently running
 * and for calling this function again after each command completes
 * until the queue is empty.
 *
 * @returns result with processed status
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // This processor runs on the REPL main thread between turns. Skip anything
  // addressed to a subagent — an unfiltered peek() returning a subagent
  // notification would set targetMode, dequeueAllMatching would find nothing
  // matching that mode with agentId===undefined, and we'd return processed:
  // false with the queue unchanged → the React effect never re-fires and any
  // queued user prompt stalls permanently.
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  const next = peek(isMainThread)
  if (!next) {
    return { processed: false }
  }

  // Task notifications batch by bucket: multiple agent completions that
  // arrived during one turn should fold into a single user message turn
  // so the model isn't paged once per agent.
  if (next.mode === 'task-notification') {
    const commands = dequeueAllMatching(
      cmd =>
        isMainThread(cmd) && isSameQueueSchedulingBucket(cmd, next),
    )
    if (commands.length === 0) {
      return { processed: false }
    }
    void executeInput(commands)
    return { processed: true }
  }

  // Everything else (prompt, bash, slash, orphaned-permission) drains a
  // single command per call. The useQueueProcessor effect re-fires after
  // each turn ends and pulls the next item, so the queue still drains
  // fully — it just does so one turn at a time. This keeps the queue
  // preview anchored at the bottom of the CLI for any items the user
  // queued behind the one that just started processing.
  const cmd = dequeue(isMainThread)!
  void executeInput([cmd])
  return { processed: true }
}

/**
 * Checks if the queue has pending commands.
 * Use this to determine if queue processing should be triggered.
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
