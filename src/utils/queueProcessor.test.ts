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

const { clearCommandQueue, enqueue, getCommandQueue, popAllEditable } = await import(
  './messageQueueManager.js'
)
const { processQueueIfReady } = await import('./queueProcessor.js')

afterEach(() => {
  clearCommandQueue()
})

describe('processQueueIfReady', () => {
  test('does not batch deferred prompts with non-deferred prompts', () => {
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
    expect(batches).toEqual([['first', 'second']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual(['deferred'])
  })

  test('restores deferred prompts as queue commands for editing', () => {
    enqueue({ value: 'fix this', mode: 'prompt', deferUntilTurnEnd: true })

    expect(popAllEditable('', 0)?.text).toBe('/queue fix this')
    expect(getCommandQueue()).toEqual([])
  })

  test('drains deferred prompts together when they are the active bucket', () => {
    enqueue({ value: 'first deferred', mode: 'prompt', deferUntilTurnEnd: true })
    enqueue({ value: 'normal', mode: 'prompt' })
    enqueue({ value: 'second deferred', mode: 'prompt', deferUntilTurnEnd: true })

    const batches: string[][] = []
    const result = processQueueIfReady({
      executeInput: async commands => {
        batches.push(commands.map(cmd => cmd.value as string))
      },
    })

    expect(result).toEqual({ processed: true })
    expect(batches).toEqual([['first deferred', 'second deferred']])
    expect(getCommandQueue().map(cmd => cmd.value)).toEqual(['normal'])
  })
})
