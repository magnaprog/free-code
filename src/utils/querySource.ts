import type { QuerySource } from '../constants/querySource.js'

export function isMainThreadQuerySource(querySource?: QuerySource): boolean {
  return (
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'
  )
}
