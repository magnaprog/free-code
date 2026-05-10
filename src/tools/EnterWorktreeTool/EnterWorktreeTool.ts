import { realpath } from 'fs/promises'
import { basename, isAbsolute, resolve } from 'path'
import { z } from 'zod/v4'
import { getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { saveCurrentProjectConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import { findCanonicalGitRoot, getBranch, gitExe } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { saveWorktreeState } from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  type WorktreeSession,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      name: z
        .string()
        .superRefine((s, ctx) => {
          try {
            validateWorktreeSlug(s)
          } catch (e) {
            ctx.addIssue({ code: 'custom', message: (e as Error).message })
          }
        })
        .optional()
        .describe(
          'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
        ),
      path: z
        .string()
        .superRefine((s, ctx) => {
          if (!isAbsolute(s)) {
            ctx.addIssue({
              code: 'custom',
              message: 'Worktree path must be absolute',
            })
          }
        })
        .optional()
        .describe('Absolute path to an existing worktree to switch into.'),
    })
    .refine(input => !(input.name && input.path), {
      message: 'Specify name or path, not both',
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ExistingWorktreeInfo = {
  worktreePath: string
  worktreeBranch?: string
  headCommit?: string
}

function parseWorktreeBranch(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

async function getExistingWorktreeInfo(
  repoRoot: string,
  requestedPath: string,
): Promise<ExistingWorktreeInfo> {
  const resolvedPath = resolve(requestedPath)
  const requestedRealPath = await realpath(resolvedPath).catch(() => {
    throw new Error(`Worktree path does not exist: ${resolvedPath}`)
  })
  const mainRealPath = await realpath(repoRoot)
  if (requestedRealPath === mainRealPath) {
    throw new Error(`${resolvedPath} is the main repository, not a linked worktree`)
  }

  const { code, stdout, stderr } = await execFileNoThrowWithCwd(
    gitExe(),
    ['worktree', 'list', '--porcelain'],
    { cwd: repoRoot },
  )
  if (code !== 0) {
    throw new Error(`Failed to list git worktrees: ${stderr}`)
  }

  for (const block of stdout.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n')
    const worktreePath = lines
      .find(line => line.startsWith('worktree '))
      ?.slice('worktree '.length)
    if (!worktreePath) continue

    const worktreeRealPath = await realpath(worktreePath).catch(() =>
      resolve(worktreePath),
    )
    if (worktreeRealPath !== requestedRealPath) continue

    const branchRef = lines
      .find(line => line.startsWith('branch '))
      ?.slice('branch '.length)
    const headCommit = lines
      .find(line => line.startsWith('HEAD '))
      ?.slice('HEAD '.length)
    return {
      worktreePath,
      worktreeBranch: parseWorktreeBranch(branchRef),
      headCommit,
    }
  }

  throw new Error(`${resolvedPath} is not a worktree of this repository`)
}

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'create an isolated git worktree and switch into it',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Creates an isolated worktree (via git or configured hooks) and switches the session into it'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Entering worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.path ?? input.name ?? ''
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    // Validate not already in a worktree created by this session
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    // Resolve to main repo root so worktree creation works from within a worktree
    const mainRepoRoot = findCanonicalGitRoot(getCwd())
    if (mainRepoRoot && mainRepoRoot !== getCwd()) {
      process.chdir(mainRepoRoot)
      setCwd(mainRepoRoot)
    }

    if (input.path) {
      if (!mainRepoRoot) {
        throw new Error('Cannot enter an existing worktree: not in a git repository')
      }
      const existingWorktree = await getExistingWorktreeInfo(
        mainRepoRoot,
        input.path,
      )
      const worktreeSession: WorktreeSession = {
        originalCwd: getCwd(),
        worktreePath: existingWorktree.worktreePath,
        worktreeName: basename(existingWorktree.worktreePath),
        worktreeBranch: existingWorktree.worktreeBranch,
        originalBranch: await getBranch(),
        originalHeadCommit: existingWorktree.headCommit,
        sessionId: getSessionId(),
        deleteBranchOnRemove: false,
      }

      restoreWorktreeSession(worktreeSession)
      process.chdir(worktreeSession.worktreePath)
      setCwd(worktreeSession.worktreePath)
      setOriginalCwd(getCwd())
      saveWorktreeState(worktreeSession)
      saveCurrentProjectConfig(current => ({
        ...current,
        activeWorktreeSession: worktreeSession,
      }))
      clearSystemPromptSections()
      clearMemoryFileCaches()
      getPlansDirectory.cache.clear?.()

      const branchInfo = worktreeSession.worktreeBranch
        ? ` on branch ${worktreeSession.worktreeBranch}`
        : ''

      return {
        data: {
          worktreePath: worktreeSession.worktreePath,
          worktreeBranch: worktreeSession.worktreeBranch,
          message: `Entered existing worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
        },
      }
    }

    const slug = input.name ?? getPlanSlug()

    const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    saveWorktreeState(worktreeSession)
    // Clear cached system prompt sections so env_info_simple recomputes with worktree context
    clearSystemPromptSections()
    // Clear memoized caches that depend on CWD
    clearMemoryFileCaches()
    getPlansDirectory.cache.clear?.()

    logEvent('tengu_worktree_created', {
      mid_session: true,
    })

    const branchInfo = worktreeSession.worktreeBranch
      ? ` on branch ${worktreeSession.worktreeBranch}`
      : ''

    return {
      data: {
        worktreePath: worktreeSession.worktreePath,
        worktreeBranch: worktreeSession.worktreeBranch,
        message: `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
