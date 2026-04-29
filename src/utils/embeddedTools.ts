import { spawnSync } from 'child_process'
import { isInBundledMode } from './bundledMode.js'
import { isEnvTruthy } from './envUtils.js'

let embeddedSearchToolsAvailable: boolean | undefined

function hasEmbeddedSearchTool(argv0: 'bfs' | 'ugrep'): boolean {
  const result = spawnSync(process.execPath, ['--version'], {
    argv0,
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return result.status === 0 && new RegExp(`\\b${argv0}\\b`, 'i').test(output)
}

function hasEmbeddedSearchToolDispatch(): boolean {
  embeddedSearchToolsAvailable ??=
    hasEmbeddedSearchTool('bfs') && hasEmbeddedSearchTool('ugrep')
  return embeddedSearchToolsAvailable
}

/**
 * Whether this build has bfs/ugrep embedded in the bun binary (ant-native only).
 *
 * When true:
 * - `find` and `grep` in Claude's Bash shell are shadowed by shell functions
 *   that invoke the bun binary with argv0='bfs' / argv0='ugrep' (same trick
 *   as embedded ripgrep)
 * - The dedicated Glob/Grep tools are removed from the tool registry
 * - Prompt guidance steering Claude away from find/grep is omitted
 *
 * Set as a build-time define in scripts/build-with-plugins.ts for ant-native builds.
 */
export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) return false
  if (!isInBundledMode()) return false
  if (!hasEmbeddedSearchToolDispatch()) return false
  const e = process.env.CLAUDE_CODE_ENTRYPOINT
  return (
    e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
  )
}

/**
 * Path to the bun binary that contains the embedded search tools.
 * Only meaningful when hasEmbeddedSearchTools() is true.
 */
export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
