import { feature } from 'bun:bundle'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * Controls whether tool-result artifacts are indexed to disk for later
 * recall. Off by default — the indexing has disk-space and security
 * (path-disclosure) implications and should be explicit opt-in.
 *
 * Env var is honored independent of feature flag so users can enable
 * recall on builds without the experimental flag compiled in.
 */
export function isArtifactIndexingEnabled(): boolean {
  // `feature()` must be a direct condition (bun:bundle constraint).
  if (feature('CONTEXT_RECALL')) return true
  return isEnvTruthy(process.env.CLAUDE_CODE_CONTEXT_RECALL)
}

/**
 * Whether to expose the `context_recall` tool to the model. Currently
 * tracks artifact indexing 1:1 — surfacing the tool with no index to read
 * makes no sense. Split if a future state requires read-only recall on
 * pre-existing indexes without continuing to write new ones.
 */
export function isContextRecallToolEnabled(): boolean {
  return isArtifactIndexingEnabled()
}
