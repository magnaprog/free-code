import { feature } from 'bun:bundle'
import type { QuerySource } from '../../constants/querySource.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { getUserContext } from '../../context.js'
import { clearSpeculativeChecks } from '../../tools/BashTool/bashPermissions.js'
import { isMainThreadQuerySource } from '../../utils/querySource.js'
import { clearClassifierApprovals } from '../../utils/classifierApprovals.js'
import { resetGetMemoryFilesCache } from '../../utils/claudemd.js'
import { clearSessionMessagesCache } from '../../utils/sessionStorage.js'
import { clearBetaTracingState } from '../../utils/telemetry/betaSessionTracing.js'
import { resetMicrocompactState } from './microCompact.js'

/**
 * Run main-thread cleanup of caches and tracking state after compaction.
 * Call this after both auto-compact and manual /compact; subagent calls
 * return without clearing shared process state.
 *
 * Note: We intentionally do NOT clear invoked skill content here.
 * Skill content must survive across multiple compactions so that
 * createSkillAttachmentIfNeeded() can include the full skill text
 * in subsequent compaction attachments.
 *
 * querySource: pass the compacting query's source so subagent compacts
 * can skip shared module-level cleanup. Subagents (agent:*) run in the
 * same process and share state with the main thread; clearing caches or
 * tracking state for a subagent compact would corrupt the main thread's
 * conversation. All compaction callers should pass querySource —
 * undefined is only safe for genuinely main-thread-only callers.
 */
export { isMainThreadQuerySource }

export function runPostCompactCleanup(querySource?: QuerySource): void {
  const isMainThreadCompact = isMainThreadQuerySource(querySource)

  if (!isMainThreadCompact) {
    return
  }

  resetMicrocompactState()
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ;(
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    ).resetContextCollapse()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  // getUserContext is a memoized outer layer wrapping getClaudeMds() →
  // getMemoryFiles(). If only the inner getMemoryFiles cache is cleared,
  // the next turn hits the getUserContext cache and never reaches
  // getMemoryFiles(), so the armed InstructionsLoaded hook never fires.
  // Keep this centralized so manual, auto, and reactive compaction paths
  // all apply the same querySource gate.
  getUserContext.cache.clear?.()
  resetGetMemoryFilesCache('compact')
  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  // Intentionally NOT calling resetSentSkillNames(): re-injecting the full
  // skill_listing (~4K tokens) post-compact is pure cache_creation. The
  // model still has SkillTool in schema, invoked_skills preserves used
  // skills, and dynamic additions are handled by skillChangeDetector /
  // cacheUtils resets. See compactConversation() for full rationale.
  clearBetaTracingState()
  if (feature('COMMIT_ATTRIBUTION')) {
    void import('../../utils/attributionHooks.js').then(m =>
      m.sweepFileContentCache(),
    )
  }
  clearSessionMessagesCache()
}
