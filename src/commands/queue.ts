import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'

export const call: LocalCommandCall = async () => ({
  type: 'text',
  value:
    'Use /queue <message> from the interactive prompt to queue a message for after the current turn.',
})

const queue = {
  type: 'local',
  name: 'queue',
  description: 'Queue a message for after the current turn',
  argumentHint: '<message>',
  supportsNonInteractive: false,
  // Interactive /queue handling lives in PromptInput.onSubmit.
  // Kept so /queue appears in help and command suggestions.
  load: () => Promise.resolve({ call }),
} satisfies Command

export default queue
