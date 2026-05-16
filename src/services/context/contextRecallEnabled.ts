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
