import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('../bootstrap/state.js', () => ({
  addSlowOperation: () => {},
  getSessionId: () => 'test-session',
}))

mock.module('./sessionStorage.js', () => ({
  recordQueueOperation: () => {},
}))

mock.module('./messages.js', () => ({
  extractTextContent: () => '',
}))

const { clearCommandQueue, enqueue, enqueuePendingNotification, getCommandQueue, popAllEditable } = await import(
  './messageQueueManager.js'
)
const { processQueueIfReady } = await import('./queueProcessor.js')

afterEach(() => {
  clearCommandQueue()
})

describe('processQueueIfReady', () => {
  test('drains a single non-deferred prompt at a time', () => {
    enqueue({ value: 'first', mode: 'prompt' })
    enqueue({ value: 'deferred', mode: 'prompt', deferUntilTurnEnd: true })
    enqueue({ value: 'second', mode: 'prompt' })

    const batches: string[][] = []
    const result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })

    expect(result).toEqual({ processed: true })
    // Only the head non-deferred prompt drains; the rest stay queued so
    // the prompt-area preview keeps showing them between turns.
    expect(batches).toEqual([['first']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual([
      'deferred',
      'second',
    ])
  })

  test('restores deferred prompts as queue commands for editing', () => {
    enqueue({ value: 'fix this', mode: 'prompt', deferUntilTurnEnd: true })

    expect(popAllEditable('', 0)?.text).toBe('/queue fix this')
    expect(getCommandQueue()).toEqual([])
  })

  test('drains a single prompt per call across mixed deferred/non-deferred queues', () => {
    enqueue({ value: 'first deferred', mode: 'prompt', deferUntilTurnEnd: true })
    enqueue({ value: 'normal', mode: 'prompt' })
    enqueue({ value: 'second deferred', mode: 'prompt', deferUntilTurnEnd: true })

    // Same priority across all three — peek returns the head (insertion order).
    let batches: string[][] = []
    let result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })
    expect(result).toEqual({ processed: true })
    expect(batches).toEqual([['first deferred']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual([
      'normal',
      'second deferred',
    ])

    batches = []
    result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })
    expect(result).toEqual({ processed: true })
    expect(batches).toEqual([['normal']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual(['second deferred'])

    batches = []
    result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })
    expect(result).toEqual({ processed: true })
    expect(batches).toEqual([['second deferred']])
    expect(getCommandQueue()).toEqual([])
  })

  test('batches task notifications in the same bucket', () => {
    enqueuePendingNotification({
      value: '<task-notification>a</task-notification>',
      mode: 'task-notification',
      isMeta: true,
    })
    enqueuePendingNotification({
      value: '<task-notification>b</task-notification>',
      mode: 'task-notification',
      isMeta: true,
    })

    const batches: string[][] = []
    const result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })

    expect(result).toEqual({ processed: true })
    expect(batches).toEqual([
      [
        '<task-notification>a</task-notification>',
        '<task-notification>b</task-notification>',
      ],
    ])
    expect(getCommandQueue()).toEqual([])
  })

  test('drains slash commands one at a time', () => {
    enqueue({ value: '/clear', mode: 'prompt' })
    enqueue({ value: '/help', mode: 'prompt' })

    const batches: string[][] = []
    processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })

    expect(batches).toEqual([['/clear']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual(['/help'])
  })
})
