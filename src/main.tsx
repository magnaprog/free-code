// These side-effects must run before all other imports:
// 1. profileCheckpoint marks entry before heavy module evaluation begins
// 2. startMdmRawRead fires MDM subprocesses (plutil/reg query) so they run in
//    parallel with the remaining ~135ms of imports below
// 3. startKeychainPrefetch fires both macOS keychain reads (OAuth + legacy API
//    key) in parallel — isRemoteManagedSettingsEligible() otherwise reads them
//    sequentially via sync spawn inside applySafeConfigEnvironmentVariables()
//    (~65ms on every macOS startup)
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry');
import { startMdmRawRead } from './utils/settings/mdm/rawRead.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead();
import { ensureKeychainPrefetchCompleted, startKeychainPrefetch } from './utils/secureStorage/keychainPrefetch.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch();
import { feature } from 'bun:bundle';
import { Command as CommanderCommand, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import mapValues from 'lodash-es/mapValues.js';
import pickBy from 'lodash-es/pickBy.js';
import uniqBy from 'lodash-es/uniqBy.js';
import React from 'react';
import { getOauthConfig } from './constants/oauth.js';
import { getRemoteSessionUrl } from './constants/product.js';
import { getSystemContext, getUserContext } from './context.js';
import { init, initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { addToHistory } from './history.js';
import type { Root } from './ink.js';
import { launchRepl } from './replLauncher.js';
import { hasGrowthBookEnvOverride, initializeGrowthBook, refreshGrowthBookAfterAuthChange } from './services/analytics/growthbook.js';
import { fetchBootstrapData } from './services/api/bootstrap.js';
import { type DownloadResult, downloadSessionFiles, type FilesApiConfig, parseFileSpecs } from './services/api/filesApi.js';
import { prefetchPassesEligibility } from './services/api/referral.js';
import { prefetchOfficialMcpUrls } from './services/mcp/officialRegistry.js';
import type { McpSdkServerConfig, McpServerConfig, ScopedMcpServerConfig } from './services/mcp/types.js';
import { isPolicyAllowed, loadPolicyLimits, refreshPolicyLimits, waitForPolicyLimitsToLoad } from './services/policyLimits/index.js';
import { loadRemoteManagedSettings, refreshRemoteManagedSettings } from './services/remoteManagedSettings/index.js';
import type { ToolInputJSONSchema } from './Tool.js';
import { createSyntheticOutputTool, isSyntheticOutputToolEnabled } from './tools/SyntheticOutputTool/SyntheticOutputTool.js';
import { getTools } from './tools.js';
import { canUserConfigureAdvisor, getInitialAdvisorSetting, isAdvisorEnabled, isValidAdvisorModel, modelSupportsAdvisor } from './utils/advisor.js';
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js';
import { count, uniq } from './utils/array.js';
import { installAsciicastRecorder } from './utils/asciicast.js';
import { getSubscriptionType, isClaudeAISubscriber, prefetchAwsCredentialsAndBedRockInfoIfSafe, prefetchGcpCredentialsIfSafe, validateForceLoginOrg } from './utils/auth.js';
import { checkHasTrustDialogAccepted, getGlobalConfig, getRemoteControlAtStartup, isAutoUpdaterDisabled, saveGlobalConfig } from './utils/config.js';
import { seedEarlyInput, stopCapturingEarlyInput } from './utils/earlyInput.js';
import { getInitialEffortSetting, parseEffortValue } from './utils/effort.js';
import { getInitialFastModeSetting, isFastModeEnabled, prefetchFastModeStatus, resolveFastModeStatusFromCache } from './utils/fastMode.js';
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import { createSystemMessage, createUserMessage } from './utils/messages.js';
import { getPlatform } from './utils/platform.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSessionIngressAuthToken } from './utils/sessionIngressAuth.js';
import { settingsChangeDetector } from './utils/settings/changeDetector.js';
import { skillChangeDetector } from './utils/skills/skillChangeDetector.js';
import { jsonParse, writeFileSync_DEPRECATED } from './utils/slowOperations.js';
import { computeInitialTeamContext } from './utils/swarm/reconnection.js';
import { initializeWarningHandler } from './utils/warningHandler.js';
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js';

// Lazy require to avoid circular dependency: teammate.ts -> AppState.tsx -> ... -> main.tsx
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeammateUtils = () => require('./utils/teammate.js') as typeof import('./utils/teammate.js');
const getTeammatePromptAddendum = () => require('./utils/swarm/teammatePromptAddendum.js') as typeof import('./utils/swarm/teammatePromptAddendum.js');
const getTeammateModeSnapshot = () => require('./utils/swarm/backends/teammateModeSnapshot.js') as typeof import('./utils/swarm/backends/teammateModeSnapshot.js');
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for COORDINATOR_MODE
/* eslint-disable @typescript-eslint/no-require-imports */
const coordinatorModeModule = feature('COORDINATOR_MODE') ? require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */
// Dead code elimination: conditional import for KAIROS (assistant mode)
/* eslint-disable @typescript-eslint/no-require-imports */
const assistantModule = feature('KAIROS') ? require('./assistant/index.js') as typeof import('./assistant/index.js') : null;
const kairosGate = feature('KAIROS') ? require('./assistant/gate.js') as typeof import('./assistant/gate.js') : null;
import { relative, resolve } from 'path';
import { isAnalyticsDisabled } from 'src/services/analytics/config.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { initializeAnalyticsGates } from 'src/services/analytics/sink.js';
import { getOriginalCwd, setAdditionalDirectoriesForClaudeMd, setIsRemoteMode, setMainLoopModelOverride, setMainThreadAgentType, setTeleportedSessionInfo } from './bootstrap/state.js';
import { filterCommandsForRemoteMode, getCommands } from './commands.js';
import type { StatsStore } from './context/stats.js';
import { launchAssistantInstallWizard, launchAssistantSessionChooser, launchInvalidSettingsDialog, launchResumeChooser, launchSnapshotUpdateDialog, launchTeleportRepoMismatchDialog, launchTeleportResumeWrapper } from './dialogLaunchers.js';
import { SHOW_CURSOR } from './ink/termio/dec.js';
import { exitWithError, exitWithMessage, getRenderContext, renderAndRun, showSetupScreens } from './interactiveHelpers.js';
import { initBuiltinPlugins } from './plugins/bundled/index.js';
/* eslint-enable @typescript-eslint/no-require-imports */
import { checkQuotaStatus } from './services/claudeAiLimits.js';
import { getMcpToolsCommandsAndResources, prefetchAllMcpResources } from './services/mcp/client.js';
import { VALID_INSTALLABLE_SCOPES, VALID_UPDATE_SCOPES } from './services/plugins/pluginCliCommands.js';
import { initBundledSkills } from './skills/bundled/index.js';
import type { AgentColorName } from './tools/AgentTool/agentColorManager.js';
import { getActiveAgentsFromList, getAgentDefinitionsWithOverrides, isBuiltInAgent, isCustomAgent, parseAgentsFromJson } from './tools/AgentTool/loadAgentsDir.js';
import type { LogOption } from './types/logs.js';
import type { Message as MessageType } from './types/message.js';
import { assertMinVersion } from './utils/autoUpdater.js';
import { CLAUDE_IN_CHROME_SKILL_HINT, CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER } from './utils/claudeInChrome/prompt.js';
import { setupClaudeInChrome, shouldAutoEnableClaudeInChrome, shouldEnableClaudeInChrome } from './utils/claudeInChrome/setup.js';
import { getContextWindowForModel } from './utils/context.js';
import { loadConversationForResume } from './utils/conversationRecovery.js';
import { buildDeepLinkBanner } from './utils/deepLink/banner.js';
import { hasNodeOption, isBareMode, isEnvTruthy, isInProtectedNamespace } from './utils/envUtils.js';
import { refreshExampleCommands } from './utils/exampleCommands.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
import { getWorktreePaths } from './utils/getWorktreePaths.js';
import { findGitRoot, getBranch, getIsGit, getWorktreeCount } from './utils/git.js';
import { getGhAuthStatus } from './utils/github/ghAuthStatus.js';
import { safeParseJSON } from './utils/json.js';
import { logError } from './utils/log.js';
import { getModelDeprecationWarning } from './utils/model/deprecation.js';
import { getDefaultMainLoopModel, getUserSpecifiedModelSetting, normalizeModelStringForAPI, parseUserSpecifiedModel } from './utils/model/model.js';
import { ensureModelStringsInitialized } from './utils/model/modelStrings.js';
import { PERMISSION_MODES } from './utils/permissions/PermissionMode.js';
import { checkAndDisableBypassPermissions, getAutoModeEnabledStateIfCached, initializeToolPermissionContext, initialPermissionModeFromCLI, isDefaultPermissionModeAuto, parseToolListFromCLI, removeDangerousPermissions, stripDangerousPermissionsForAutoMode, verifyAutoModeGateAccess } from './utils/permissions/permissionSetup.js';
import { cleanupOrphanedPluginVersionsInBackground } from './utils/plugins/cacheUtils.js';
import { initializeVersionedPlugins } from './utils/plugins/installedPluginsManager.js';
import { getManagedPluginNames } from './utils/plugins/managedPlugins.js';
import { getGlobExclusionsForPluginCache } from './utils/plugins/orphanedPluginFilter.js';
import { getPluginSeedDirs } from './utils/plugins/pluginDirectories.js';
import { countFilesRoundedRg } from './utils/ripgrep.js';
import { processSessionStartHooks, processSetupHooks } from './utils/sessionStart.js';
import { cacheSessionTitle, getSessionIdFromLog, loadTranscriptFromFile, saveAgentSetting, saveMode, searchSessionsByCustomTitle, sessionIdExists } from './utils/sessionStorage.js';
import { ensureMdmSettingsLoaded } from './utils/settings/mdm/settings.js';
import { getInitialSettings, getManagedSettingsKeysForLogging, getSettingsForSource, getSettingsWithErrors } from './utils/settings/settings.js';
import { resetSettingsCache } from './utils/settings/settingsCache.js';
import type { ValidationError } from './utils/settings/validation.js';
import { DEFAULT_TASKS_MODE_TASK_LIST_ID, TASK_STATUSES } from './utils/tasks.js';
import { logPluginLoadErrors, logPluginsEnabledForSession } from './utils/telemetry/pluginTelemetry.js';
import { logSkillsLoaded } from './utils/telemetry/skillLoadedEvent.js';
import { generateTempFilePath } from './utils/tempfile.js';
import { validateUuid } from './utils/uuid.js';
// Plugin startup checks are now handled non-blockingly in REPL.tsx

import { registerMcpAddCommand } from 'src/commands/mcp/addCommand.js';
import { registerMcpXaaIdpCommand } from 'src/commands/mcp/xaaIdpCommand.js';
import { logPermissionContextForAnts } from 'src/services/internalLogging.js';
import { fetchClaudeAIMcpConfigsIfEligible } from 'src/services/mcp/claudeai.js';
import { clearServerCache } from 'src/services/mcp/client.js';
import { areMcpConfigsAllowedWithEnterpriseMcpConfig, dedupClaudeAiMcpServers, doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getClaudeCodeMcpConfigs, getMcpServerSignature, parseMcpConfig, parseMcpConfigFromFilePath } from 'src/services/mcp/config.js';
import { excludeCommandsByServer, excludeResourcesByServer } from 'src/services/mcp/utils.js';
import { isXaaEnabled } from 'src/services/mcp/xaaIdpLogin.js';
import { getRelevantTips } from 'src/services/tips/tipRegistry.js';
import { logContextMetrics } from 'src/utils/api.js';
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME, isClaudeInChromeMCPServer } from 'src/utils/claudeInChrome/common.js';
import { registerCleanup } from 'src/utils/cleanupRegistry.js';
import { eagerParseCliFlag } from 'src/utils/cliArgs.js';
import { createEmptyAttributionState } from 'src/utils/commitAttribution.js';
import { countConcurrentSessions, registerSession, updateSessionName } from 'src/utils/concurrentSessions.js';
import { getCwd } from 'src/utils/cwd.js';
import { logForDebugging, setHasFormattedOutput } from 'src/utils/debug.js';
import { errorMessage, getErrnoCode, isENOENT, TeleportOperationError, toError } from 'src/utils/errors.js';
import { getFsImplementation, safeResolvePath } from 'src/utils/fsOperations.js';
import { gracefulShutdown, gracefulShutdownSync } from 'src/utils/gracefulShutdown.js';
import { setAllHookEventsEnabled } from 'src/utils/hooks/hookEvents.js';
import { refreshModelCapabilities } from 'src/utils/model/modelCapabilities.js';
import { peekForStdinData, writeToStderr } from 'src/utils/process.js';
import { setCwd } from 'src/utils/Shell.js';
import { type ProcessedResume, processResumedConversation } from 'src/utils/sessionRestore.js';
import { parseSettingSourcesFlag } from 'src/utils/settings/constants.js';
import { plural } from 'src/utils/stringUtils.js';
import { type ChannelEntry, getInitialMainLoopModel, getIsNonInteractiveSession, getSdkBetas, getSessionId, getUserMsgOptIn, setAllowedChannels, setAllowedSettingSources, setChromeFlagOverride, setClientType, setCwdState, setDirectConnectServerUrl, setFlagSettingsPath, setInitialMainLoopModel, setInlinePlugins, setIsInteractive, setKairosActive, setOriginalCwd, setQuestionPreviewFormat, setSdkBetas, setSessionBypassPermissionsMode, setSessionPersistenceDisabled, setSessionSource, setUserMsgOptIn, switchSession } from './bootstrap/state.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const autoModeStateModule = feature('TRANSCRIPT_CLASSIFIER') ? require('./utils/permissions/autoModeState.js') as typeof import('./utils/permissions/autoModeState.js') : null;

// TeleportRepoMismatchDialog, TeleportResumeWrapper dynamically imported at call sites
import { migrateAutoUpdatesToSettings } from './migrations/migrateAutoUpdatesToSettings.js';
import { migrateBypassPermissionsAcceptedToSettings } from './migrations/migrateBypassPermissionsAcceptedToSettings.js';
import { migrateEnableAllProjectMcpServersToSettings } from './migrations/migrateEnableAllProjectMcpServersToSettings.js';
import { migrateFennecToOpus } from './migrations/migrateFennecToOpus.js';
import { migrateLegacyOpusToCurrent } from './migrations/migrateLegacyOpusToCurrent.js';
import { migrateOpusToOpus1m } from './migrations/migrateOpusToOpus1m.js';
import { migrateReplBridgeEnabledToRemoteControlAtStartup } from './migrations/migrateReplBridgeEnabledToRemoteControlAtStartup.js';
import { migrateSonnet1mToSonnet45 } from './migrations/migrateSonnet1mToSonnet45.js';
import { migrateSonnet45ToSonnet46 } from './migrations/migrateSonnet45ToSonnet46.js';
import { resetAutoModeOptInForDefaultOffer } from './migrations/resetAutoModeOptInForDefaultOffer.js';
import { resetProToOpusDefault } from './migrations/resetProToOpusDefault.js';
import { createRemoteSessionConfig } from './remote/RemoteSessionManager.js';
/* eslint-enable @typescript-eslint/no-require-imports */
// teleportWithProgress dynamically imported at call site
import { createDirectConnectSession, DirectConnectError } from './server/createDirectConnectSession.js';
import { initializeLspServerManager } from './services/lsp/manager.js';
import { shouldEnablePromptSuggestion } from './services/PromptSuggestion/promptSuggestion.js';
import { type AppState, getDefaultAppState, IDLE_SPECULATION_STATE } from './state/AppStateStore.js';
import { onChangeAppState } from './state/onChangeAppState.js';
import { createStore } from './state/store.js';
import { asSessionId } from './types/ids.js';
import { filterAllowedSdkBetas } from './utils/betas.js';
import { isInBundledMode, isRunningWithBun } from './utils/bundledMode.js';
import { logForDiagnosticsNoPII } from './utils/diagLogs.js';
import { filterExistingPaths, getKnownPathsForRepo } from './utils/githubRepoPathMapping.js';
import { clearPluginCache, loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js';
import { migrateChangelogFromConfig } from './utils/releaseNotes.js';
import { SandboxManager } from './utils/sandbox/sandbox-adapter.js';
import { fetchSession, prepareApiRequest } from './utils/teleport/api.js';
import { checkOutTeleportedSessionBranch, processMessagesForTeleportResume, teleportToRemoteWithErrorHandling, validateGitState, validateSessionRepository } from './utils/teleport.js';
import { shouldEnableThinkingByDefault, type ThinkingConfig } from './utils/thinking.js';
import { initUser, resetUserCache } from './utils/user.js';
import { getTmuxInstallInstructions, isTmuxAvailable, parsePRReference } from './utils/worktree.js';

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded');

/**
 * Log managed settings keys to Statsig for analytics.
 * This is called after init() completes to ensure settings are loaded
 * and environment variables are applied before model resolution.
 */
function logManagedSettings(): void {
  try {
    const policySettings = getSettingsForSource('policySettings');
    if (policySettings) {
      const allKeys = getManagedSettingsKeysForLogging(policySettings);
      logEvent('tengu_managed_settings_loaded', {
        keyCount: allKeys.length,
        keys: allKeys.join(',') as unknown as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    }
  } catch {
    // Silently ignore errors - this is just for analytics
  }
}

// Check if running in debug/inspection mode
function isBeingDebugged() {
  const isBun = isRunningWithBun();

  // Check for inspect flags in process arguments (including all variants)
  const hasInspectArg = process.execArgv.some(arg => {
    if (isBun) {
      // Note: Bun has an issue with single-file executables where application arguments
      // from process.argv leak into process.execArgv (similar to https://github.com/oven-sh/bun/issues/11673)
      // This breaks use of --debug mode if we omit this branch
      // We're fine to skip that check, because Bun doesn't support Node.js legacy --debug or --debug-brk flags
      return /--inspect(-brk)?/.test(arg);
    } else {
      // In Node.js, check for both --inspect and legacy --debug flags
      return /--inspect(-brk)?|--debug(-brk)?/.test(arg);
    }
  });

  // Check if NODE_OPTIONS contains inspect flags
  const hasInspectEnv = process.env.NODE_OPTIONS && /--inspect(-brk)?|--debug(-brk)?/.test(process.env.NODE_OPTIONS);

  // Check if inspector is available and active (indicates debugging)
  try {
    // Dynamic import would be better but is async - use global object instead
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inspector = (global as any).require('inspector');
    const hasInspectorUrl = !!inspector.url();
    return hasInspectorUrl || hasInspectArg || hasInspectEnv;
  } catch {
    // Ignore error and fall back to argument detection
    return hasInspectArg || hasInspectEnv;
  }
}

// Exit if we detect node debugging or inspection
if ("external" !== 'ant' && isBeingDebugged()) {
  // Use process.exit directly here since we're in the top-level code before imports
  // and gracefulShutdown is not yet available
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1);
}

/**
 * Per-session skill/plugin telemetry. Called from both the interactive path
 * and the headless -p path (before runHeadless) — both go through
 * main.tsx but branch before the interactive startup path, so it needs two
 * call sites here rather than one here + one in QueryEngine.
 */
function logSessionTelemetry(): void {
  const model = parseUserSpecifiedModel(getInitialMainLoopModel() ?? getDefaultMainLoopModel());
  void logSkillsLoaded(getCwd(), getContextWindowForModel(model, getSdkBetas()));
  void loadAllPluginsCacheOnly().then(({
    enabled,
    errors
  }) => {
    const managedNames = getManagedPluginNames();
    logPluginsEnabledForSession(enabled, managedNames, getPluginSeedDirs());
    logPluginLoadErrors(errors, managedNames);
  }).catch(err => logError(err));
}
function getCertEnvVarTelemetry(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  if (process.env.NODE_EXTRA_CA_CERTS) {
    result.has_node_extra_ca_certs = true;
  }
  if (process.env.CLAUDE_CODE_CLIENT_CERT) {
    result.has_client_cert = true;
  }
  if (hasNodeOption('--use-system-ca')) {
    result.has_use_system_ca = true;
  }
  if (hasNodeOption('--use-openssl-ca')) {
    result.has_use_openssl_ca = true;
  }
  return result;
}
async function logStartupTelemetry(): Promise<void> {
  if (isAnalyticsDisabled()) return;
  const [isGit, worktreeCount, ghAuthStatus] = await Promise.all([getIsGit(), getWorktreeCount(), getGhAuthStatus()]);
  logEvent('tengu_startup_telemetry', {
    is_git: isGit,
    worktree_count: worktreeCount,
    gh_auth_status: ghAuthStatus as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    sandbox_enabled: SandboxManager.isSandboxingEnabled(),
    are_unsandboxed_commands_allowed: SandboxManager.areUnsandboxedCommandsAllowed(),
    is_auto_bash_allowed_if_sandbox_enabled: SandboxManager.isAutoAllowBashIfSandboxedEnabled(),
    auto_updater_disabled: isAutoUpdaterDisabled(),
    prefers_reduced_motion: getInitialSettings().prefersReducedMotion ?? false,
    ...getCertEnvVarTelemetry()
  });
}

// @[MODEL LAUNCH]: Consider any migrations you may need for model strings. See migrateSonnet1mToSonnet45.ts for an example.
// Bump this when adding a new sync migration so existing users re-run the set.
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    migrateEnableAllProjectMcpServersToSettings();
    resetProToOpusDefault();
    migrateSonnet1mToSonnet45();
    migrateLegacyOpusToCurrent();
    migrateSonnet45ToSonnet46();
    migrateOpusToOpus1m();
    migrateReplBridgeEnabledToRemoteControlAtStartup();
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      resetAutoModeOptInForDefaultOffer();
    }
    if ("external" === 'ant') {
      migrateFennecToOpus();
    }
    saveGlobalConfig(prev => prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev : {
      ...prev,
      migrationVersion: CURRENT_MIGRATION_VERSION
    });
  }
  // Async migration - fire and forget since it's non-blocking
  migrateChangelogFromConfig().catch(() => {
    // Silently ignore migration errors - will retry on next startup
  });
}

/**
 * Prefetch system context (including git status) only when it's safe to do so.
 * Git commands can execute arbitrary code via hooks and config (e.g., core.fsmonitor,
 * diff.external), so we must only run them after trust is established or in
 * non-interactive mode where trust is implicit.
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession();

  // In non-interactive mode (--print), trust dialog is skipped and
  // execution is considered trusted (as documented in help text)
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive');
    void getSystemContext();
    return;
  }

  // In interactive mode, only prefetch if trust has already been established
  const hasTrust = checkHasTrustDialogAccepted();
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust');
    void getSystemContext();
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust');
  }
  // Otherwise, don't prefetch - wait for trust to be established first
}

/**
 * Start background prefetches and housekeeping that are NOT needed before first render.
 * These are deferred from setup() to reduce event loop contention and child process
 * spawning during the critical startup path.
 * Call this after the REPL has been rendered.
 */
export function startDeferredPrefetches(): void {
  // This function runs after first render, so it doesn't block the initial paint.
  // However, the spawned processes and async work still contend for CPU and event
  // loop time, which skews startup benchmarks (CPU profiles, time-to-first-render
  // measurements). Skip all of it when we're only measuring startup performance.
  if (isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER) ||
  // --bare: skip ALL prefetches. These are cache-warms for the REPL's
  // first-turn responsiveness (initUser, getUserContext, tips, countFiles,
  // modelCapabilities, change detectors). Scripted -p calls don't have a
  // "user is typing" window to hide this work in — it's pure overhead on
  // the critical path.
  isBareMode()) {
    return;
  }

  // Process-spawning prefetches (consumed at first API call, user is still typing)
  void initUser();
  void getUserContext();
  prefetchSystemContextIfSafe();
  void getRelevantTips();
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
    void prefetchAwsCredentialsAndBedRockInfoIfSafe();
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) && !isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
    void prefetchGcpCredentialsIfSafe();
  }
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), []);

  // Analytics and feature flag initialization
  void initializeAnalyticsGates();
  void prefetchOfficialMcpUrls();
  void refreshModelCapabilities();

  // File change detectors deferred from init() to unblock first render
  void settingsChangeDetector.initialize();
  if (!isBareMode()) {
    void skillChangeDetector.initialize();
  }

  // Event loop stall detector — logs when the main thread is blocked >500ms
  if ("external" === 'ant') {
    void import('./utils/eventLoopStallDetector.js').then(m => m.startEventLoopStallDetector());
  }
}
function loadSettingsFromFlag(settingsFile: string): void {
  try {
    const trimmedSettings = settingsFile.trim();
    const looksLikeJson = trimmedSettings.startsWith('{') && trimmedSettings.endsWith('}');
    let settingsPath: string;
    if (looksLikeJson) {
      // It's a JSON string - validate and create temp file
      const parsedJson = safeParseJSON(trimmedSettings);
      if (!parsedJson) {
        process.stderr.write(chalk.red('Error: Invalid JSON provided to --settings\n'));
        process.exit(1);
      }

      // Create a temporary file and write the JSON to it.
      // Use a content-hash-based path instead of random UUID to avoid
      // busting the Anthropic API prompt cache. The settings path ends up
      // in the Bash tool's sandbox denyWithinAllow list, which is part of
      // the tool description sent to the API. A random UUID per subprocess
      // changes the tool description on every query() call, invalidating
      // the cache prefix and causing a 12x input token cost penalty.
      // The content hash ensures identical settings produce the same path
      // across process boundaries (each SDK query() spawns a new process).
      settingsPath = generateTempFilePath('claude-settings', '.json', {
        contentHash: trimmedSettings
      });
      writeFileSync_DEPRECATED(settingsPath, trimmedSettings, 'utf8');
    } else {
      // It's a file path - resolve and validate by attempting to read
      const {
        resolvedPath: resolvedSettingsPath
      } = safeResolvePath(getFsImplementation(), settingsFile);
      try {
        readFileSync(resolvedSettingsPath, 'utf8');
      } catch (e) {
        if (isENOENT(e)) {
          process.stderr.write(chalk.red(`Error: Settings file not found: ${resolvedSettingsPath}\n`));
          process.exit(1);
        }
        throw e;
      }
      settingsPath = resolvedSettingsPath;
    }
    setFlagSettingsPath(settingsPath);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing settings: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}
function loadSettingSourcesFromFlag(settingSourcesArg: string): void {
  try {
    const sources = parseSettingSourcesFlag(settingSourcesArg);
    setAllowedSettingSources(sources);
    resetSettingsCache();
  } catch (error) {
    if (error instanceof Error) {
      logError(error);
    }
    process.stderr.write(chalk.red(`Error processing --setting-sources: ${errorMessage(error)}\n`));
    process.exit(1);
  }
}

/**
 * Parse and load settings flags early, before init()
 * This ensures settings are filtered from the start of initialization
 */
function eagerLoadSettings(): void {
  profileCheckpoint('eagerLoadSettings_start');
  // Parse --settings flag early to ensure settings are loaded before init()
  const settingsFile = eagerParseCliFlag('--settings');
  if (settingsFile) {
    loadSettingsFromFlag(settingsFile);
  }

  // Parse --setting-sources flag early to control which sources are loaded
  const settingSourcesArg = eagerParseCliFlag('--setting-sources');
  if (settingSourcesArg !== undefined) {
    loadSettingSourcesFromFlag(settingSourcesArg);
  }
  profileCheckpoint('eagerLoadSettings_end');
}
function initializeEntrypoint(isNonInteractive: boolean): void {
  // Skip if already set (e.g., by SDK or other entrypoints)
  if (process.env.CLAUDE_CODE_ENTRYPOINT) {
    return;
  }
  const cliArgs = process.argv.slice(2);

  // Check for MCP serve command (handle flags before mcp serve, e.g., --debug mcp serve)
  const mcpIndex = cliArgs.indexOf('mcp');
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'mcp';
    return;
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ACTION)) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-code-github-action';
    return;
  }

  // Note: 'local-agent' entrypoint is set by the local agent mode launcher
  // via CLAUDE_CODE_ENTRYPOINT env var (handled by early return above)

  // Set based on interactive status
  process.env.CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli';
}

// Set by early argv processing when `claude open <url>` is detected (interactive mode only)
type PendingConnect = {
  url: string | undefined;
  authToken: string | undefined;
  dangerouslySkipPermissions: boolean;
};
const _pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT') ? {
  url: undefined,
  authToken: undefined,
  dangerouslySkipPermissions: false
} : undefined;

// Set by early argv processing when `claude assistant [sessionId]` is detected
type PendingAssistantChat = {
  sessionId?: string;
  discover: boolean;
};
const _pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS') ? {
  sessionId: undefined,
  discover: false
} : undefined;

// `claude ssh <host> [dir]` — parsed from argv early (same pattern as
// DIRECT_CONNECT above) so the main command path can pick it up and hand
// the REPL an SSH-backed session instead of a local one.
type PendingSSH = {
  host: string | undefined;
  cwd: string | undefined;
  permissionMode: string | undefined;
  dangerouslySkipPermissions: boolean;
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean;
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[];
};
const _pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE') ? {
  host: undefined,
  cwd: undefined,
  permissionMode: undefined,
  dangerouslySkipPermissions: false,
  local: false,
  extraCliArgs: []
} : undefined;
export async function main() {
  profileCheckpoint('main_function_start');

  // SECURITY: Prevent Windows from executing commands from current directory
  // This must be set before ANY command execution to prevent PATH hijacking attacks
  // See: https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1';

  // Initialize warning handler early to catch warnings
  initializeWarningHandler();
  process.on('exit', () => {
    resetCursor();
  });
  process.on('SIGINT', () => {
    // In print mode, print.ts registers its own SIGINT handler that aborts
    // the in-flight query and calls gracefulShutdown; skip here to avoid
    // preempting it with a synchronous process.exit().
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return;
    }
    process.exit(0);
  });
  profileCheckpoint('main_warning_handler_initialized');

  // Check for cc:// or cc+unix:// URL in argv — rewrite so the main command
  // handles it, giving the full interactive TUI instead of a stripped-down subcommand.
  // For headless (-p), we rewrite to the internal `open` subcommand.
  if (feature('DIRECT_CONNECT')) {
    const rawCliArgs = process.argv.slice(2);
    const ccIdx = rawCliArgs.findIndex(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
    if (ccIdx !== -1 && _pendingConnect) {
      const ccUrl = rawCliArgs[ccIdx]!;
      const {
        parseConnectUrl
      } = await import('./server/parseConnectUrl.js');
      const parsed = parseConnectUrl(ccUrl);
      _pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes('--dangerously-skip-permissions');
      if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
        // Headless: rewrite to internal `open` subcommand
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped];
      } else {
        // Interactive: strip cc:// URL and flags, run main command
        _pendingConnect.url = parsed.serverUrl;
        _pendingConnect.authToken = parsed.authToken;
        const stripped = rawCliArgs.filter((_, i) => i !== ccIdx);
        const dspIdx = stripped.indexOf('--dangerously-skip-permissions');
        if (dspIdx !== -1) {
          stripped.splice(dspIdx, 1);
        }
        process.argv = [process.argv[0]!, process.argv[1]!, ...stripped];
      }
    }
  }

  // Handle deep link URIs early — this is invoked by the OS protocol handler
  // and should bail out before full init since it only needs to parse the URI
  // and open a terminal.
  if (feature('LODESTONE')) {
    const handleUriIdx = process.argv.indexOf('--handle-uri');
    if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const uri = process.argv[handleUriIdx + 1]!;
      const {
        handleDeepLinkUri
      } = await import('./utils/deepLink/protocolHandler.js');
      const exitCode = await handleDeepLinkUri(uri);
      process.exit(exitCode);
    }

    // macOS URL handler: when LaunchServices launches our .app bundle, the
    // URL arrives via Apple Event (not argv). LaunchServices overwrites
    // __CFBundleIdentifier to the launching bundle's ID, which is a precise
    // positive signal — cheaper than importing and guessing with heuristics.
    if (process.platform === 'darwin' && process.env.__CFBundleIdentifier === 'com.anthropic.claude-code-url-handler') {
      const {
        enableConfigs
      } = await import('./utils/config.js');
      enableConfigs();
      const {
        handleUrlSchemeLaunch
      } = await import('./utils/deepLink/protocolHandler.js');
      const urlSchemeResult = await handleUrlSchemeLaunch();
      process.exit(urlSchemeResult ?? 1);
    }
  }

  // `claude assistant [sessionId]` — stash and strip so the main
  // command handles it, giving the full interactive TUI. Position-0 only
  // (matching the ssh pattern below) — indexOf would false-positive on
  // `claude -p "explain assistant"`. Root-flag-before-subcommand
  // (e.g. `--debug assistant`) falls through to the stub, which
  // prints usage.
  if (feature('KAIROS') && _pendingAssistantChat) {
    const rawArgs = process.argv.slice(2);
    if (rawArgs[0] === 'assistant') {
      const nextArg = rawArgs[1];
      if (nextArg && !nextArg.startsWith('-')) {
        _pendingAssistantChat.sessionId = nextArg;
        rawArgs.splice(0, 2); // drop 'assistant' and sessionId
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      } else if (!nextArg) {
        _pendingAssistantChat.discover = true;
        rawArgs.splice(0, 1); // drop 'assistant'
        process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs];
      }
      // else: `claude assistant --help` → fall through to stub
    }
  }

  // `claude ssh <host> [dir]` — strip from argv so the main command handler
  // runs (full interactive TUI), stash the host/dir for the REPL branch at
  // ~line 3720 to pick up. Headless (-p) mode not supported in v1: SSH
  // sessions need the local REPL to drive them (interrupt, permissions).
  if (feature('SSH_REMOTE') && _pendingSSH) {
    const rawCliArgs = process.argv.slice(2);
    // SSH-specific flags can appear before the host positional (e.g.
    // `ssh --permission-mode auto host /tmp` — standard POSIX flags-before-
    // positionals). Pull them all out BEFORE checking whether a host was
    // given, so `claude ssh --permission-mode auto host` and `claude ssh host
    // --permission-mode auto` are equivalent. The host check below only needs
    // to guard against `-h`/`--help` (which commander should handle).
    if (rawCliArgs[0] === 'ssh') {
      const localIdx = rawCliArgs.indexOf('--local');
      if (localIdx !== -1) {
        _pendingSSH.local = true;
        rawCliArgs.splice(localIdx, 1);
      }
      const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions');
      if (dspIdx !== -1) {
        _pendingSSH.dangerouslySkipPermissions = true;
        rawCliArgs.splice(dspIdx, 1);
      }
      const pmIdx = rawCliArgs.indexOf('--permission-mode');
      if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
        _pendingSSH.permissionMode = rawCliArgs[pmIdx + 1];
        rawCliArgs.splice(pmIdx, 2);
      }
      const pmEqIdx = rawCliArgs.findIndex(a => a.startsWith('--permission-mode='));
      if (pmEqIdx !== -1) {
        _pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1];
        rawCliArgs.splice(pmEqIdx, 1);
      }
      // Forward session-resume + model flags to the remote CLI's initial spawn.
      // --continue/-c and --resume <uuid> operate on the REMOTE session history
      // (which persists under the remote's ~/.claude/projects/<cwd>/).
      // --model controls which model the remote uses.
      const extractFlag = (flag: string, opts: {
        hasValue?: boolean;
        as?: string;
      } = {}) => {
        const i = rawCliArgs.indexOf(flag);
        if (i !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag);
          const val = rawCliArgs[i + 1];
          if (opts.hasValue && val && !val.startsWith('-')) {
            _pendingSSH.extraCliArgs.push(val);
            rawCliArgs.splice(i, 2);
          } else {
            rawCliArgs.splice(i, 1);
          }
        }
        const eqI = rawCliArgs.findIndex(a => a.startsWith(`${flag}=`));
        if (eqI !== -1) {
          _pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1));
          rawCliArgs.splice(eqI, 1);
        }
      };
      extractFlag('-c', {
        as: '--continue'
      });
      extractFlag('--continue');
      extractFlag('--resume', {
        hasValue: true
      });
      extractFlag('--model', {
        hasValue: true
      });
    }
    // After pre-extraction, any remaining dash-arg at [1] is either -h/--help
    // (commander handles) or an unknown-to-ssh flag (fall through to commander
    // so it surfaces a proper error). Only a non-dash arg is the host.
    if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
      _pendingSSH.host = rawCliArgs[1];
      // Optional positional cwd.
      let consumed = 2;
      if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
        _pendingSSH.cwd = rawCliArgs[2];
        consumed = 3;
      }
      const rest = rawCliArgs.slice(consumed);

      // Headless (-p) mode is not supported with SSH in v1 — reject early
      // so the flag doesn't silently cause local execution.
      if (rest.includes('-p') || rest.includes('--print')) {
        process.stderr.write('Error: headless (-p/--print) mode is not supported with claude ssh\n');
        gracefulShutdownSync(1);
        return;
      }

      // Rewrite argv so the main command sees remaining flags but not `ssh`.
      process.argv = [process.argv[0]!, process.argv[1]!, ...rest];
    }
  }

  // Check for -p/--print and --init-only flags early to set isInteractiveSession before init()
  // This is needed because telemetry initialization calls auth functions that need this flag
  const cliArgs = process.argv.slice(2);
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print');
  const hasInitOnlyFlag = cliArgs.includes('--init-only');
  const hasSdkUrl = cliArgs.some(arg => arg.startsWith('--sdk-url'));
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY;

  // Stop capturing early input for non-interactive modes
  if (isNonInteractive) {
    stopCapturingEarlyInput();
  }

  // Set simplified tracking fields
  const isInteractive = !isNonInteractive;
  setIsInteractive(isInteractive);

  // Initialize entrypoint based on mode - needs to be set before any event is logged
  initializeEntrypoint(isNonInteractive);

  // Determine client type
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) return 'github-action';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-ts') return 'sdk-typescript';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-py') return 'sdk-python';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli') return 'sdk-cli';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode') return 'claude-vscode';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') return 'local-agent';
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return 'claude-desktop';

    // Check if session-ingress token is provided (indicates remote session)
    const hasSessionIngressToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN || process.env.CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR;
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote';
    }
    return 'cli';
  })();
  setClientType(clientType);
  const previewFormat = process.env.CLAUDE_CODE_QUESTION_PREVIEW_FORMAT;
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat);
  } else if (!clientType.startsWith('sdk-') &&
  // Desktop and CCR pass previewFormat via toolConfig; when the feature is
  // gated off they pass undefined — don't override that with markdown.
  clientType !== 'claude-desktop' && clientType !== 'local-agent' && clientType !== 'remote') {
    setQuestionPreviewFormat('markdown');
  }

  // Tag sessions created via `claude remote-control` so the backend can identify them
  if (process.env.CLAUDE_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control');
  }
  profileCheckpoint('main_client_type_determined');

  // Parse and load settings flags early, before init()
  eagerLoadSettings();
  profileCheckpoint('main_before_run');
  await run();
  profileCheckpoint('main_after_run');
}
async function getInputPrompt(prompt: string, inputFormat: 'text' | 'stream-json'): Promise<string | AsyncIterable<string>> {
  if (!process.stdin.isTTY &&
  // Input hijacking breaks MCP.
  !process.argv.includes('mcp')) {
    if (inputFormat === 'stream-json') {
      return process.stdin;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    const onData = (chunk: string) => {
      data += chunk;
    };
    process.stdin.on('data', onData);
    // If no data arrives in 3s, stop waiting and warn. Stdin is likely an
    // inherited pipe from a parent that isn't writing (subprocess spawned
    // without explicit stdin handling). 3s covers slow producers like curl,
    // jq on large files, python with import overhead. The warning makes
    // silent data loss visible for the rare producer that's slower still.
    const timedOut = await peekForStdinData(process.stdin, 3000);
    process.stdin.off('data', onData);
    if (timedOut) {
      process.stderr.write('Warning: no stdin data received in 3s, proceeding without it. ' + 'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n');
    }
    return [prompt, data].filter(Boolean).join('\n');
  }
  return prompt;
}
async function run(): Promise<CommanderCommand> {
  profileCheckpoint('run_function_start');

  // Create help config that sorts options by long option name.
  // Commander supports compareOptions at runtime but @commander-js/extra-typings
  // doesn't include it in the type definitions, so we use Object.assign to add it.
  function createSortedHelpConfig(): {
    sortSubcommands: true;
    sortOptions: true;
  } {
    const getOptionSortKey = (opt: Option): string => opt.long?.replace(/^--/, '') ?? opt.short?.replace(/^-/, '') ?? '';
    return Object.assign({
      sortSubcommands: true,
      sortOptions: true
    } as const, {
      compareOptions: (a: Option, b: Option) => getOptionSortKey(a).localeCompare(getOptionSortKey(b))
    });
  }
  const program = new CommanderCommand().configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  profileCheckpoint('run_commander_initialized');

  // Use preAction hook to run initialization only when executing a command,
  // not when displaying help. This avoids the need for env variable signaling.
  program.hook('preAction', async thisCommand => {
    profileCheckpoint('preAction_start');
    // Await async subprocess loads started at module evaluation (lines 12-20).
    // Nearly free — subprocesses complete during the ~135ms of imports above.
    // Must resolve before init() which triggers the first settings read
    // (applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → sync keychain reads otherwise ~65ms).
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()]);
    profileCheckpoint('preAction_after_mdm');
    await init();
    profileCheckpoint('preAction_after_init');

    // process.title on Windows sets the console title directly; on POSIX,
    // terminal shell integration may mirror the process name to the tab.
    // After init() so settings.json env can also gate this (gh-4765).
    if (!isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'claude';
    }

    // Attach logging sinks so subcommand handlers can use logEvent/logError.
    // Before PR #11106 logEvent dispatched directly; after, events queue until
    // a sink attaches. setup() attaches sinks for the default command, but
    // subcommands (doctor, mcp, plugin, auth) never call setup() and would
    // silently drop events on process.exit(). Both inits are idempotent.
    const {
      initSinks
    } = await import('./utils/sinks.js');
    initSinks();
    profileCheckpoint('preAction_after_sinks');

    // gh-33508: --plugin-dir is a top-level program option. The default
    // action reads it from its own options destructure, but subcommands
    // (plugin list, plugin install, mcp *) have their own actions and
    // never see it. Wire it up here so getInlinePlugins() works everywhere.
    // thisCommand.opts() is typed {} here because this hook is attached
    // before .option('--plugin-dir', ...) in the chain — extra-typings
    // builds the type as options are added. Narrow with a runtime guard;
    // the collect accumulator + [] default guarantee string[] in practice.
    const pluginDir = thisCommand.getOptionValue('pluginDir');
    if (Array.isArray(pluginDir) && pluginDir.length > 0 && pluginDir.every(p => typeof p === 'string')) {
      setInlinePlugins(pluginDir);
      clearPluginCache('preAction: --plugin-dir inline plugins');
    }
    runMigrations();
    profileCheckpoint('preAction_after_migrations');

    // Load remote managed settings for enterprise customers (non-blocking)
    // Fails open - if fetch fails, continues without remote settings
    // Settings are applied via hot-reload when they arrive
    // Must happen after init() to ensure config reading is allowed
    void loadRemoteManagedSettings();
    void loadPolicyLimits();
    profileCheckpoint('preAction_after_remote_settings');

    // Load settings sync (non-blocking, fail-open)
    // CLI: uploads local settings to remote (CCR download is handled by print.ts)
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settingsSync/index.js').then(m => m.uploadUserSettingsInBackground());
    }
    profileCheckpoint('preAction_after_settings_sync');
  });
  program.name('claude').description(`Claude Code - starts an interactive session by default, use -p/--print for non-interactive output`).argument('[prompt]', 'Your prompt', String)
  // Subcommands inherit helpOption via commander's copyInheritedSettings —
  // setting it once here covers mcp, plugin, auth, and all other subcommands.
  .helpOption('-h, --help', 'Display help for command').option('-d, --debug [filter]', 'Enable debug mode with optional category filtering (e.g., "api,hooks" or "!1p,!file")', (_value: string | true) => {
    // If value is provided, it will be the filter string
    // If not provided but flag is present, value will be true
    // The actual filtering is handled in debug.ts by parsing process.argv
    return true;
  }).addOption(new Option('-D, --debug-to-stderr', 'Enable debug mode (to stderr)').argParser(Boolean).hideHelp()).option('--debug-file <path>', 'Write debug logs to a specific file path (implicitly enables debug mode)', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).option('-p, --print', 'Print response and exit (useful for pipes). Note: The workspace trust dialog is skipped when Claude is run with the -p mode. Only use this flag in directories you trust.', () => true).option('--bare', 'Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory, background prefetches, keychain reads, and CLAUDE.md auto-discovery. Sets CLAUDE_CODE_SIMPLE=1. Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never read). 3P providers (Bedrock/Vertex/Foundry) use their own credentials. Skills still resolve via /skill-name. Explicitly provide context via: --system-prompt[-file], --append-system-prompt[-file], --add-dir (CLAUDE.md dirs), --mcp-config, --settings, --agents, --plugin-dir.', () => true).addOption(new Option('--init', 'Run Setup hooks with init trigger, then continue').hideHelp()).addOption(new Option('--init-only', 'Run Setup and SessionStart:startup hooks, then exit').hideHelp()).addOption(new Option('--maintenance', 'Run Setup hooks with maintenance trigger, then continue').hideHelp()).addOption(new Option('--output-format <format>', 'Output format (only works with --print): "text" (default), "json" (single result), or "stream-json" (realtime streaming)').choices(['text', 'json', 'stream-json'])).addOption(new Option('--json-schema <schema>', 'JSON Schema for structured output validation. ' + 'Example: {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}').argParser(String)).option('--include-hook-events', 'Include all hook lifecycle events in the output stream (only works with --output-format=stream-json)', () => true).option('--include-partial-messages', 'Include partial message chunks as they arrive (only works with --print and --output-format=stream-json)', () => true).addOption(new Option('--input-format <format>', 'Input format (only works with --print): "text" (default), or "stream-json" (realtime streaming input)').choices(['text', 'stream-json'])).option('--mcp-debug', '[DEPRECATED. Use --debug instead] Enable MCP debug mode (shows MCP server errors)', () => true).option('--dangerously-skip-permissions', 'Bypass all permission checks. Recommended only for sandboxes with no internet access.', () => true).option('--allow-dangerously-skip-permissions', 'Enable bypassing all permission checks as an option, without it being enabled by default. Recommended only for sandboxes with no internet access.', () => true).addOption(new Option('--thinking <mode>', 'Thinking mode: enabled (equivalent to adaptive), disabled').choices(['enabled', 'adaptive', 'disabled']).hideHelp()).addOption(new Option('--max-thinking-tokens <tokens>', '[DEPRECATED. Use --thinking instead for newer models] Maximum number of thinking tokens (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-turns <turns>', 'Maximum number of agentic turns in non-interactive mode. This will early exit the conversation after the specified number of turns. (only works with --print)').argParser(Number).hideHelp()).addOption(new Option('--max-budget-usd <amount>', 'Maximum dollar amount to spend on API calls (only works with --print)').argParser(value => {
    const amount = Number(value);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('--max-budget-usd must be a positive number greater than 0');
    }
    return amount;
  })).addOption(new Option('--task-budget <tokens>', 'API-side task budget in tokens (output_config.task_budget)').argParser(value => {
    const tokens = Number(value);
    if (isNaN(tokens) || tokens <= 0 || !Number.isInteger(tokens)) {
      throw new Error('--task-budget must be a positive integer');
    }
    return tokens;
  }).hideHelp()).option('--replay-user-messages', 'Re-emit user messages from stdin back on stdout for acknowledgment (only works with --input-format=stream-json and --output-format=stream-json)', () => true).addOption(new Option('--enable-auth-status', 'Enable auth status messages in SDK mode').default(false).hideHelp()).option('--allowedTools, --allowed-tools <tools...>', 'Comma or space-separated list of tool names to allow (e.g. "Bash(git:*) Edit")').option('--tools <tools...>', 'Specify the list of available tools from the built-in set. Use "" to disable all tools, "default" to use all tools, or specify tool names (e.g. "Bash,Edit,Read").').option('--disallowedTools, --disallowed-tools <tools...>', 'Comma or space-separated list of tool names to deny (e.g. "Bash(git:*) Edit")').option('--mcp-config <configs...>', 'Load MCP servers from JSON files or strings (space-separated)').addOption(new Option('--permission-prompt-tool <tool>', 'MCP tool to use for permission prompts (only works with --print)').argParser(String).hideHelp()).addOption(new Option('--system-prompt <prompt>', 'System prompt to use for the session').argParser(String)).addOption(new Option('--system-prompt-file <file>', 'Read system prompt from a file').argParser(String).hideHelp()).addOption(new Option('--append-system-prompt <prompt>', 'Append a system prompt to the default system prompt').argParser(String)).addOption(new Option('--append-system-prompt-file <file>', 'Read system prompt from a file and append to the default system prompt').argParser(String).hideHelp()).addOption(new Option('--permission-mode <mode>', 'Permission mode to use for the session').argParser(String).choices(PERMISSION_MODES)).option('-c, --continue', 'Continue the most recent conversation in the current directory', () => true).option('-r, --resume [value]', 'Resume a conversation by session ID, or open interactive picker with optional search term', value => value || true).option('--fork-session', 'When resuming, create a new session ID instead of reusing the original (use with --resume or --continue)', () => true).addOption(new Option('--prefill <text>', 'Pre-fill the prompt input with text without submitting it').hideHelp()).addOption(new Option('--deep-link-origin', 'Signal that this session was launched from a deep link').hideHelp()).addOption(new Option('--deep-link-repo <slug>', 'Repo slug the deep link ?repo= parameter resolved to the current cwd').hideHelp()).addOption(new Option('--deep-link-last-fetch <ms>', 'FETCH_HEAD mtime in epoch ms, precomputed by the deep link trampoline').argParser(v => {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }).hideHelp()).option('--from-pr [value]', 'Resume a session linked to a PR by PR number/URL, or open interactive picker with optional search term', value => value || true).option('--no-session-persistence', 'Disable session persistence - sessions will not be saved to disk and cannot be resumed (only works with --print)').addOption(new Option('--resume-session-at <message id>', 'When resuming, only messages up to and including the assistant message with <message.id> (use with --resume in print mode)').argParser(String).hideHelp()).addOption(new Option('--rewind-files <user-message-id>', 'Restore files to state at the specified user message and exit (requires --resume)').hideHelp())
  // @[MODEL LAUNCH]: Update the example model ID in the --model help text.
  .option('--model <model>', `Model for the current session. Provide an alias for the latest model (e.g. 'sonnet' or 'opus') or a model's full name (e.g. 'claude-opus-4-7').`).addOption(new Option('--effort <level>', `Effort level for the current session (low, medium, high, xhigh, max)`).argParser((rawValue: string) => {
    const value = rawValue.toLowerCase();
    const allowed = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`);
    }
    return value;
  })).option('--agent <agent>', `Agent for the current session. Overrides the 'agent' setting.`).option('--betas <betas...>', 'Beta headers to include in API requests (API key users only)').option('--fallback-model <model>', 'Enable automatic fallback to specified model when default model is overloaded (only works with --print)').addOption(new Option('--workload <tag>', 'Workload tag for billing-header attribution (cc_workload). Process-scoped; set by SDK daemon callers that spawn subprocesses for cron work. (only works with --print)').hideHelp()).option('--settings <file-or-json>', 'Path to a settings JSON file or a JSON string to load additional settings from').option('--add-dir <directories...>', 'Additional directories to allow tool access to').option('--ide', 'Automatically connect to IDE on startup if exactly one valid IDE is available', () => true).option('--strict-mcp-config', 'Only use MCP servers from --mcp-config, ignoring all other MCP configurations', () => true).option('--session-id <uuid>', 'Use a specific session ID for the conversation (must be a valid UUID)').option('-n, --name <name>', 'Set a display name for this session (shown in /resume and terminal title)').option('--agents <json>', 'JSON object defining custom agents (e.g. \'{"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}\')').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).')
  // gh-33508: <paths...> (variadic) consumed everything until the next
  // --flag. `claude --plugin-dir /path mcp add --transport http` swallowed
  // `mcp` and `add` as paths, then choked on --transport as an unknown
  // top-level option. Single-value + collect accumulator means each
  // --plugin-dir takes exactly one arg; repeat the flag for multiple dirs.
  .option('--plugin-dir <path>', 'Load plugins from a directory for this session only (repeatable: --plugin-dir A --plugin-dir B)', (val: string, prev: string[]) => [...prev, val], [] as string[]).option('--disable-slash-commands', 'Disable all skills', () => true).option('--chrome', 'Enable Claude in Chrome integration').option('--no-chrome', 'Disable Claude in Chrome integration').option('--file <specs...>', 'File resources to download at startup. Format: file_id:relative_path (e.g., --file file_abc:doc.txt file_def:img.png)').action(async (prompt, options) => {
    profileCheckpoint('action_handler_start');

    // --bare = one-switch minimal mode. Sets SIMPLE so all the existing
    // gates fire (CLAUDE.md, skills, hooks inside executeHooks, agent
    // dir-walk). Must be set before setup() / any of the gated work runs.
    if ((options as {
      bare?: boolean;
    }).bare) {
      process.env.CLAUDE_CODE_SIMPLE = '1';
    }

    // Ignore "code" as a prompt - treat it the same as no prompt
    if (prompt === 'code') {
      logEvent('tengu_code_prompt_ignored', {});
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.warn(chalk.yellow('Tip: You can launch Claude Code with just `claude`'));
      prompt = undefined;
    }

    // Log event for any single-word prompt
    if (prompt && typeof prompt === 'string' && !/\s/.test(prompt) && prompt.length > 0) {
      logEvent('tengu_single_word_prompt', {
        length: prompt.length
      });
    }

    // Assistant mode: when .claude/settings.json has assistant: true AND
    // the tengu_kairos GrowthBook gate is on, force brief on. Permission
    // mode is left to the user — settings defaultMode or --permission-mode
    // apply as normal. REPL-typed messages already default to 'next'
    // priority (messageQueueManager.enqueue) so they drain mid-turn between
    // tool calls. SendUserMessage (BriefTool) is enabled via the brief env
    // var. SleepTool stays disabled (its isEnabled() gates on proactive).
    // kairosEnabled is computed once here and reused at the
    // getAssistantSystemPromptAddendum() call site further down.
    //
    // Trust gate: .claude/settings.json is attacker-controllable in an
    // untrusted clone. We run ~1000 lines before showSetupScreens() shows
    // the trust dialog, and by then we've already appended
    // .claude/agents/assistant.md to the system prompt. Refuse to activate
    // until the directory has been explicitly trusted.
    let kairosEnabled = false;
    let assistantTeamContext: Awaited<ReturnType<NonNullable<typeof assistantModule>['initializeAssistantTeam']>> | undefined;
    if (feature('KAIROS') && (options as {
      assistant?: boolean;
    }).assistant && assistantModule) {
      // --assistant (Agent SDK daemon mode): force the latch before
      // isAssistantMode() runs below. The daemon has already checked
      // entitlement — don't make the child re-check tengu_kairos.
      assistantModule.markAssistantForced();
    }
    if (feature('KAIROS') && assistantModule?.isAssistantMode() &&
    // Spawned teammates share the leader's cwd + settings.json, so
    // isAssistantMode() is true for them too. --agent-id being set
    // means we ARE a spawned teammate (extractTeammateOptions runs
    // ~170 lines later so check the raw commander option) — don't
    // re-init the team or override teammateMode/proactive/brief.
    !(options as {
      agentId?: unknown;
    }).agentId && kairosGate) {
      if (!checkHasTrustDialogAccepted()) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.warn(chalk.yellow('Assistant mode disabled: directory is not trusted. Accept the trust dialog and restart.'));
      } else {
        // Blocking gate check — returns cached `true` instantly; if disk
        // cache is false/missing, lazily inits GrowthBook and fetches fresh
        // (max ~5s). --assistant skips the gate entirely (daemon is
        // pre-entitled).
        kairosEnabled = assistantModule.isAssistantForced() || (await kairosGate.isKairosEnabled());
        if (kairosEnabled) {
          const opts = options as {
            brief?: boolean;
          };
          opts.brief = true;
          setKairosActive(true);
          // Pre-seed an in-process team so Agent(name: "foo") spawns
          // teammates without TeamCreate. Must run BEFORE setup() captures
          // the teammateMode snapshot (initializeAssistantTeam calls
          // setCliTeammateModeOverride internally).
          assistantTeamContext = await assistantModule.initializeAssistantTeam();
        }
      }
    }
    const {
      debug = false,
      debugToStderr = false,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions = false,
      tools: baseTools = [],
      allowedTools = [],
      disallowedTools = [],
      mcpConfig = [],
      permissionMode: permissionModeCli,
      addDir = [],
      fallbackModel,
      betas = [],
      ide = false,
      sessionId,
      includeHookEvents,
      includePartialMessages
    } = options;
    if (options.prefill) {
      seedEarlyInput(options.prefill);
    }

    // Promise for file downloads - started early, awaited before REPL renders
    let fileDownloadPromise: Promise<DownloadResult[]> | undefined;
    const agentsJson = options.agents;
    const agentCli = options.agent;
    if (feature('BG_SESSIONS') && agentCli) {
      process.env.CLAUDE_CODE_AGENT = agentCli;
    }

    // NOTE: LSP manager initialization is intentionally deferred until after
    // the trust dialog is accepted. This prevents plugin LSP servers from
    // executing code in untrusted directories before user consent.

    // Extract these separately so they can be modified if needed
    let outputFormat = options.outputFormat;
    let inputFormat = options.inputFormat;
    let verbose = options.verbose ?? getGlobalConfig().verbose;
    let print = options.print;
    const init = options.init ?? false;
    const initOnly = options.initOnly ?? false;
    const maintenance = options.maintenance ?? false;

    // Extract disable slash commands flag
    const disableSlashCommands = options.disableSlashCommands || false;

    // Extract tasks mode options (ant-only)
    const tasksOption = "external" === 'ant' && (options as {
      tasks?: boolean | string;
    }).tasks;
    const taskListId = tasksOption ? typeof tasksOption === 'string' ? tasksOption : DEFAULT_TASKS_MODE_TASK_LIST_ID : undefined;
    if ("external" === 'ant' && taskListId) {
      process.env.CLAUDE_CODE_TASK_LIST_ID = taskListId;
    }

    // Extract worktree option
    // worktree can be true (flag without value) or a string (custom name or PR reference)
    const worktreeOption = isWorktreeModeEnabled() ? (options as {
      worktree?: boolean | string;
    }).worktree : undefined;
    let worktreeName = typeof worktreeOption === 'string' ? worktreeOption : undefined;
    const worktreeEnabled = worktreeOption !== undefined;

    // Check if worktree name is a PR reference (#N or GitHub PR URL)
    let worktreePRNumber: number | undefined;
    if (worktreeName) {
      const prNum = parsePRReference(worktreeName);
      if (prNum !== null) {
        worktreePRNumber = prNum;
        worktreeName = undefined; // slug will be generated in setup()
      }
    }

    // Extract tmux option (requires --worktree)
    const tmuxEnabled = isWorktreeModeEnabled() && (options as {
      tmux?: boolean;
    }).tmux === true;

    // Validate tmux option
    if (tmuxEnabled) {
      if (!worktreeEnabled) {
        process.stderr.write(chalk.red('Error: --tmux requires --worktree\n'));
        process.exit(1);
      }
      if (getPlatform() === 'windows') {
        process.stderr.write(chalk.red('Error: --tmux is not supported on Windows\n'));
        process.exit(1);
      }
      if (!(await isTmuxAvailable())) {
        process.stderr.write(chalk.red(`Error: tmux is not installed.\n${getTmuxInstallInstructions()}\n`));
        process.exit(1);
      }
    }

    // Extract teammate options (for tmux-spawned agents)
    // Declared outside the if block so it's accessible later for system prompt addendum
    let storedTeammateOpts: TeammateOptions | undefined;
    if (isAgentSwarmsEnabled()) {
      // Extract agent identity options (for tmux-spawned agents)
      // These replace the CLAUDE_CODE_* environment variables
      const teammateOpts = extractTeammateOptions(options);
      storedTeammateOpts = teammateOpts;

      // If any teammate identity option is provided, all three required ones must be present
      const hasAnyTeammateOpt = teammateOpts.agentId || teammateOpts.agentName || teammateOpts.teamName;
      const hasAllRequiredTeammateOpts = teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName;
      if (hasAnyTeammateOpt && !hasAllRequiredTeammateOpts) {
        process.stderr.write(chalk.red('Error: --agent-id, --agent-name, and --team-name must all be provided together\n'));
        process.exit(1);
      }

      // If teammate identity is provided via CLI, set up dynamicTeamContext
      if (teammateOpts.agentId && teammateOpts.agentName && teammateOpts.teamName) {
        getTeammateUtils().setDynamicTeamContext?.({
          agentId: teammateOpts.agentId,
          agentName: teammateOpts.agentName,
          teamName: teammateOpts.teamName,
          color: teammateOpts.agentColor,
          planModeRequired: teammateOpts.planModeRequired ?? false,
          parentSessionId: teammateOpts.parentSessionId
        });
      }

      // Set teammate mode CLI override if provided
      // This must be done before setup() captures the snapshot
      if (teammateOpts.teammateMode) {
        getTeammateModeSnapshot().setCliTeammateModeOverride?.(teammateOpts.teammateMode);
      }
    }

    // Extract remote sdk options
    const sdkUrl = (options as {
      sdkUrl?: string;
    }).sdkUrl ?? undefined;

    // Allow env var to enable partial messages (used by sandbox gateway for baku)
    const effectiveIncludePartialMessages = includePartialMessages || isEnvTruthy(process.env.CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES);

    // Enable all hook event types when explicitly requested via SDK option
    // or when running in CLAUDE_CODE_REMOTE mode (CCR needs them).
    // Without this, only SessionStart and Setup events are emitted.
    if (includeHookEvents || isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      setAllHookEventsEnabled(true);
    }

    // Auto-set input/output formats, verbose mode, and print mode when SDK URL is provided
    if (sdkUrl) {
      // If SDK URL is provided, automatically use stream-json formats unless explicitly set
      if (!inputFormat) {
        inputFormat = 'stream-json';
      }
      if (!outputFormat) {
        outputFormat = 'stream-json';
      }
      // Auto-enable verbose mode unless explicitly disabled or already set
      if (options.verbose === undefined) {
        verbose = true;
      }
      // Auto-enable print mode unless explicitly disabled
      if (!options.print) {
        print = true;
      }
    }

    // Extract teleport option
    const teleport = (options as {
      teleport?: string | true;
    }).teleport ?? null;

    // Extract remote option (can be true if no description provided, or a string)
    const remoteOption = (options as {
      remote?: string | true;
    }).remote;
    const remote = remoteOption === true ? '' : remoteOption ?? null;

    // Extract --remote-control / --rc flag (enable bridge in interactive session)
    const remoteControlOption = (options as {
      remoteControl?: string | true;
    }).remoteControl ?? (options as {
      rc?: string | true;
    }).rc;
    // Actual bridge check is deferred to after showSetupScreens() so that
    // trust is established and GrowthBook has auth headers.
    let remoteControl = false;
    const remoteControlName = typeof remoteControlOption === 'string' && remoteControlOption.length > 0 ? remoteControlOption : undefined;

    // Validate session ID if provided
    if (sessionId) {
      // Check for conflicting flags
      // --session-id can be used with --continue or --resume when --fork-session is also provided
      // (to specify a custom ID for the forked session)
      if ((options.continue || options.resume) && !options.forkSession) {
        process.stderr.write(chalk.red('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n'));
        process.exit(1);
      }

      // When --sdk-url is provided (bridge/remote mode), the session ID is a
      // server-assigned tagged ID (e.g. "session_local_01...") rather than a
      // UUID. Skip UUID validation and local existence checks in that case.
      if (!sdkUrl) {
        const validatedSessionId = validateUuid(sessionId);
        if (!validatedSessionId) {
          process.stderr.write(chalk.red('Error: Invalid session ID. Must be a valid UUID.\n'));
          process.exit(1);
        }

        // Check if session ID already exists
        if (sessionIdExists(validatedSessionId)) {
          process.stderr.write(chalk.red(`Error: Session ID ${validatedSessionId} is already in use.\n`));
          process.exit(1);
        }
      }
    }

    // Download file resources if specified via --file flag
    const fileSpecs = (options as {
      file?: string[];
    }).file;
    if (fileSpecs && fileSpecs.length > 0) {
      // Get session ingress token (provided by EnvManager via CLAUDE_CODE_SESSION_ACCESS_TOKEN)
      const sessionToken = getSessionIngressAuthToken();
      if (!sessionToken) {
        process.stderr.write(chalk.red('Error: Session token required for file downloads. CLAUDE_CODE_SESSION_ACCESS_TOKEN must be set.\n'));
        process.exit(1);
      }

      // Resolve session ID: prefer remote session ID, fall back to internal session ID
      const fileSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID || getSessionId();
      const files = parseFileSpecs(fileSpecs);
      if (files.length > 0) {
        // Use ANTHROPIC_BASE_URL if set (by EnvManager), otherwise use OAuth config
        // This ensures consistency with session ingress API in all environments
        const config: FilesApiConfig = {
          baseUrl: process.env.ANTHROPIC_BASE_URL || getOauthConfig().BASE_API_URL,
          oauthToken: sessionToken,
          sessionId: fileSessionId
        };

        // Start download without blocking startup - await before REPL renders
        fileDownloadPromise = downloadSessionFiles(files, config);
      }
    }

    // Get isNonInteractiveSession from state (was set before init())
    const isNonInteractiveSession = getIsNonInteractiveSession();

    // Validate that fallback model is different from main model
    if (fallbackModel && options.model && fallbackModel === options.model) {
      process.stderr.write(chalk.red('Error: Fallback model cannot be the same as the main model. Please specify a different model for --fallback-model.\n'));
      process.exit(1);
    }

    // Handle system prompt options
    let systemPrompt = options.systemPrompt;
    if (options.systemPromptFile) {
      if (options.systemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.systemPromptFile);
        systemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: System prompt file not found: ${resolve(options.systemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // Handle append system prompt options
    let appendSystemPrompt = options.appendSystemPrompt;
    if (options.appendSystemPromptFile) {
      if (options.appendSystemPrompt) {
        process.stderr.write(chalk.red('Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.\n'));
        process.exit(1);
      }
      try {
        const filePath = resolve(options.appendSystemPromptFile);
        appendSystemPrompt = readFileSync(filePath, 'utf8');
      } catch (error) {
        const code = getErrnoCode(error);
        if (code === 'ENOENT') {
          process.stderr.write(chalk.red(`Error: Append system prompt file not found: ${resolve(options.appendSystemPromptFile)}\n`));
          process.exit(1);
        }
        process.stderr.write(chalk.red(`Error reading append system prompt file: ${errorMessage(error)}\n`));
        process.exit(1);
      }
    }

    // Add teammate-specific system prompt addendum for tmux teammates
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName) {
      const addendum = getTeammatePromptAddendum().TEAMMATE_SYSTEM_PROMPT_ADDENDUM;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${addendum}` : addendum;
    }
    const {
      mode: permissionMode,
      notification: permissionModeNotification
    } = initialPermissionModeFromCLI({
      permissionModeCli,
      dangerouslySkipPermissions
    });

    // Store session bypass permissions mode for trust dialog check
    setSessionBypassPermissionsMode(permissionMode === 'bypassPermissions');
    if (feature('TRANSCRIPT_CLASSIFIER')) {
      // autoModeFlagCli is the "did the user intend auto this session" signal.
      // Set when: --enable-auto-mode, --permission-mode auto, resolved mode
      // is auto, OR settings defaultMode is auto but the gate denied it
      // (permissionMode resolved to default with no explicit CLI override).
      // Used by verifyAutoModeGateAccess to decide whether to notify on
      // auto-unavailable, and by tengu_auto_mode_config opt-in carousel.
      if ((options as {
        enableAutoMode?: boolean;
      }).enableAutoMode || permissionModeCli === 'auto' || permissionMode === 'auto' || !permissionModeCli && isDefaultPermissionModeAuto()) {
        autoModeStateModule?.setAutoModeFlagCli(true);
      }
    }

    // Parse the MCP config files/strings if provided
    let dynamicMcpConfig: Record<string, ScopedMcpServerConfig> = {};
    if (mcpConfig && mcpConfig.length > 0) {
      // Process mcpConfig array
      const processedConfigs = mcpConfig.map(config => config.trim()).filter(config => config.length > 0);
      let allConfigs: Record<string, McpServerConfig> = {};
      const allErrors: ValidationError[] = [];
      for (const configItem of processedConfigs) {
        let configs: Record<string, McpServerConfig> | null = null;
        let errors: ValidationError[] = [];

        // First try to parse as JSON string
        const parsedJson = safeParseJSON(configItem);
        if (parsedJson) {
          const result = parseMcpConfig({
            configObject: parsedJson,
            filePath: 'command line',
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        } else {
          // Try as file path
          const configPath = resolve(configItem);
          const result = parseMcpConfigFromFilePath({
            filePath: configPath,
            expandVars: true,
            scope: 'dynamic'
          });
          if (result.config) {
            configs = result.config.mcpServers;
          } else {
            errors = result.errors;
          }
        }
        if (errors.length > 0) {
          allErrors.push(...errors);
        } else if (configs) {
          // Merge configs, later ones override earlier ones
          allConfigs = {
            ...allConfigs,
            ...configs
          };
        }
      }
      if (allErrors.length > 0) {
        const formattedErrors = allErrors.map(err => `${err.path ? err.path + ': ' : ''}${err.message}`).join('\n');
        logForDebugging(`--mcp-config validation failed (${allErrors.length} errors): ${formattedErrors}`, {
          level: 'error'
        });
        process.stderr.write(`Error: Invalid MCP configuration:\n${formattedErrors}\n`);
        process.exit(1);
      }
      if (Object.keys(allConfigs).length > 0) {
        // SDK hosts (Nest/Desktop) own their server naming and may reuse
        // built-in names — skip reserved-name checks for type:'sdk'.
        const nonSdkConfigNames = Object.entries(allConfigs).filter(([, config]) => config.type !== 'sdk').map(([name]) => name);
        let reservedNameError: string | null = null;
        if (nonSdkConfigNames.some(isClaudeInChromeMCPServer)) {
          reservedNameError = `Invalid MCP configuration: "${CLAUDE_IN_CHROME_MCP_SERVER_NAME}" is a reserved MCP name.`;
        } else if (feature('CHICAGO_MCP')) {
          const {
            isComputerUseMCPServer,
            COMPUTER_USE_MCP_SERVER_NAME
          } = await import('src/utils/computerUse/common.js');
          if (nonSdkConfigNames.some(isComputerUseMCPServer)) {
            reservedNameError = `Invalid MCP configuration: "${COMPUTER_USE_MCP_SERVER_NAME}" is a reserved MCP name.`;
          }
        }
        if (reservedNameError) {
          // stderr+exit(1) — a throw here becomes a silent unhandled
          // rejection in stream-json mode (void main() in cli.tsx).
          process.stderr.write(`Error: ${reservedNameError}\n`);
          process.exit(1);
        }

        // Add dynamic scope to all configs. type:'sdk' entries pass through
        // unchanged — they're extracted into sdkMcpConfigs downstream and
        // passed to print.ts. The Python SDK relies on this path (it doesn't
        // send sdkMcpServers in the initialize message). Dropping them here
        // broke Coworker (inc-5122). The policy filter below already exempts
        // type:'sdk', and the entries are inert without an SDK transport on
        // stdin, so there's no bypass risk from letting them through.
        const scopedConfigs = mapValues(allConfigs, config => ({
          ...config,
          scope: 'dynamic' as const
        }));

        // Enforce managed policy (allowedMcpServers / deniedMcpServers) on
        // --mcp-config servers. Without this, the CLI flag bypasses the
        // enterprise allowlist that user/project/local configs go through in
        // getClaudeCodeMcpConfigs — callers spread dynamicMcpConfig back on
        // top of filtered results. Filter here at the source so all
        // downstream consumers see the policy-filtered set.
        const {
          allowed,
          blocked
        } = filterMcpServersByPolicy(scopedConfigs);
        if (blocked.length > 0) {
          process.stderr.write(`Warning: MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
        }
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...allowed
        };
      }
    }

    // Extract Claude in Chrome option and enforce claude.ai subscriber check (unless user is ant)
    const chromeOpts = options as {
      chrome?: boolean;
    };
    // Store the explicit CLI flag so teammates can inherit it
    setChromeFlagOverride(chromeOpts.chrome);
    const enableClaudeInChrome = shouldEnableClaudeInChrome(chromeOpts.chrome) && ("external" === 'ant' || isClaudeAISubscriber());
    const autoEnableClaudeInChrome = !enableClaudeInChrome && shouldAutoEnableClaudeInChrome();
    if (enableClaudeInChrome) {
      const platform = getPlatform();
      try {
        logEvent('tengu_claude_in_chrome_setup', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        const {
          mcpConfig: chromeMcpConfig,
          allowedTools: chromeMcpTools,
          systemPrompt: chromeSystemPrompt
        } = setupClaudeInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        allowedTools.push(...chromeMcpTools);
        if (chromeSystemPrompt) {
          appendSystemPrompt = appendSystemPrompt ? `${chromeSystemPrompt}\n\n${appendSystemPrompt}` : chromeSystemPrompt;
        }
      } catch (error) {
        logEvent('tengu_claude_in_chrome_setup_failed', {
          platform: platform as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
        logForDebugging(`[Claude in Chrome] Error: ${error}`);
        logError(error);
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: Failed to run with Claude in Chrome.`);
        process.exit(1);
      }
    } else if (autoEnableClaudeInChrome) {
      try {
        const {
          mcpConfig: chromeMcpConfig
        } = setupClaudeInChrome();
        dynamicMcpConfig = {
          ...dynamicMcpConfig,
          ...chromeMcpConfig
        };
        const hint = feature('WEB_BROWSER_TOOL') && typeof Bun !== 'undefined' && 'WebView' in Bun ? CLAUDE_IN_CHROME_SKILL_HINT_WITH_WEBBROWSER : CLAUDE_IN_CHROME_SKILL_HINT;
        appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${hint}` : hint;
      } catch (error) {
        // Silently skip any errors for the auto-enable
        logForDebugging(`[Claude in Chrome] Error (auto-enable): ${error}`);
      }
    }

    // Extract strict MCP config flag
    const strictMcpConfig = options.strictMcpConfig || false;

    // Check if enterprise MCP configuration exists. When it does, only allow dynamic MCP
    // configs that contain special server types (sdk)
    if (doesEnterpriseMcpConfigExist()) {
      if (strictMcpConfig) {
        process.stderr.write(chalk.red('You cannot use --strict-mcp-config when an enterprise MCP config is present'));
        process.exit(1);
      }

      // For --mcp-config, allow if all servers are internal types (sdk)
      if (dynamicMcpConfig && !areMcpConfigsAllowedWithEnterpriseMcpConfig(dynamicMcpConfig)) {
        process.stderr.write(chalk.red('You cannot dynamically configure MCP servers when an enterprise MCP config is present'));
        process.exit(1);
      }
    }

    // chicago MCP: guarded Computer Use (app allowlist + frontmost gate +
    // SCContentFilter screenshots). Ant-only, GrowthBook-gated — failures
    // are silent (this is dogfooding). Platform + interactive checks inline
    // so non-macOS / print-mode ants skip the heavy @ant/computer-use-mcp
    // import entirely. gates.js is light (type-only package import).
    //
    // Placed AFTER the enterprise-MCP-config check: that check rejects any
    // dynamicMcpConfig entry with `type !== 'sdk'`, and our config is
    // `type: 'stdio'`. An enterprise-config ant with the GB gate on would
    // otherwise process.exit(1). Chrome has the same latent issue but has
    // shipped without incident; chicago places itself correctly.
    if (feature('CHICAGO_MCP') && getPlatform() === 'macos' && !getIsNonInteractiveSession()) {
      try {
        const {
          getChicagoEnabled
        } = await import('src/utils/computerUse/gates.js');
        if (getChicagoEnabled()) {
          const {
            setupComputerUseMCP
          } = await import('src/utils/computerUse/setup.js');
          const {
            mcpConfig,
            allowedTools: cuTools
          } = setupComputerUseMCP();
          dynamicMcpConfig = {
            ...dynamicMcpConfig,
            ...mcpConfig
          };
          allowedTools.push(...cuTools);
        }
      } catch (error) {
        logForDebugging(`[Computer Use MCP] Setup failed: ${errorMessage(error)}`);
      }
    }

    // Store additional directories for CLAUDE.md loading (controlled by env var)
    setAdditionalDirectoriesForClaudeMd(addDir);

    // Channel server allowlist from --channels flag — servers whose
    // inbound push notifications should register this session. The option
    // is added inside a feature() block so TS doesn't know about it
    // on the options type — same pattern as --assistant at main.tsx:1824.
    // devChannels is deferred: showSetupScreens shows a confirmation dialog
    // and only appends to allowedChannels on accept.
    let devChannels: ChannelEntry[] | undefined;
    if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
      // Parse plugin:name@marketplace / server:Y tags into typed entries.
      // Tag decides trust model downstream: plugin-kind hits marketplace
      // verification + GrowthBook allowlist, server-kind always fails
      // allowlist (schema is plugin-only) unless dev flag is set.
      // Untagged or marketplace-less plugin entries are hard errors —
      // silently not-matching in the gate would look like channels are
      // "on" but nothing ever fires.
      const parseChannelEntries = (raw: string[], flag: string): ChannelEntry[] => {
        const entries: ChannelEntry[] = [];
        const bad: string[] = [];
        for (const c of raw) {
          if (c.startsWith('plugin:')) {
            const rest = c.slice(7);
            const at = rest.indexOf('@');
            if (at <= 0 || at === rest.length - 1) {
              bad.push(c);
            } else {
              entries.push({
                kind: 'plugin',
                name: rest.slice(0, at),
                marketplace: rest.slice(at + 1)
              });
            }
          } else if (c.startsWith('server:') && c.length > 7) {
            entries.push({
              kind: 'server',
              name: c.slice(7)
            });
          } else {
            bad.push(c);
          }
        }
        if (bad.length > 0) {
          process.stderr.write(chalk.red(`${flag} entries must be tagged: ${bad.join(', ')}\n` + `  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)\n` + `  server:<name>                — manually configured MCP server\n`));
          process.exit(1);
        }
        return entries;
      };
      const channelOpts = options as {
        channels?: string[];
        dangerouslyLoadDevelopmentChannels?: string[];
      };
      const rawChannels = channelOpts.channels;
      const rawDev = channelOpts.dangerouslyLoadDevelopmentChannels;
      // Always parse + set. ChannelsNotice reads getAllowedChannels() and
      // renders the appropriate branch (disabled/noAuth/policyBlocked/
      // listening) in the startup screen. gateChannelServer() enforces.
      // --channels works in both interactive and print/SDK modes; dev-channels
      // stays interactive-only (requires a confirmation dialog).
      let channelEntries: ChannelEntry[] = [];
      if (rawChannels && rawChannels.length > 0) {
        channelEntries = parseChannelEntries(rawChannels, '--channels');
        setAllowedChannels(channelEntries);
      }
      if (!isNonInteractiveSession) {
        if (rawDev && rawDev.length > 0) {
          devChannels = parseChannelEntries(rawDev, '--dangerously-load-development-channels');
        }
      }
      // Flag-usage telemetry. Plugin identifiers are logged (same tier as
      // tengu_plugin_installed — public-registry-style names); server-kind
      // names are not (MCP-server-name tier, opt-in-only elsewhere).
      // Per-server gate outcomes land in tengu_mcp_channel_gate once
      // servers connect. Dev entries go through a confirmation dialog after
      // this — dev_plugins captures what was typed, not what was accepted.
      if (channelEntries.length > 0 || (devChannels?.length ?? 0) > 0) {
        const joinPluginIds = (entries: ChannelEntry[]) => {
          const ids = entries.flatMap(e => e.kind === 'plugin' ? [`${e.name}@${e.marketplace}`] : []);
          return ids.length > 0 ? ids.sort().join(',') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : undefined;
        };
        logEvent('tengu_mcp_channel_flags', {
          channels_count: channelEntries.length,
          dev_count: devChannels?.length ?? 0,
          plugins: joinPluginIds(channelEntries),
          dev_plugins: joinPluginIds(devChannels ?? [])
        });
      }
    }

    // SDK opt-in for SendUserMessage via --tools. All sessions require
    // explicit opt-in; listing it in --tools signals intent. Runs BEFORE
    // initializeToolPermissionContext so getToolsForDefaultPreset() sees
    // the tool as enabled when computing the base-tools disallow filter.
    // Conditional require avoids leaking the tool-name string into
    // external builds.
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && baseTools.length > 0) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        BRIEF_TOOL_NAME,
        LEGACY_BRIEF_TOOL_NAME
      } = require('./tools/BriefTool/prompt.js') as typeof import('./tools/BriefTool/prompt.js');
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const parsed = parseToolListFromCLI(baseTools);
      if ((parsed.includes(BRIEF_TOOL_NAME) || parsed.includes(LEGACY_BRIEF_TOOL_NAME)) && isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }

    // This await replaces blocking existsSync/statSync calls that were already in
    // the startup path. Wall-clock time is unchanged; we just yield to the event
    // loop during the fs I/O instead of blocking it. See #19661.
    const initResult = await initializeToolPermissionContext({
      allowedToolsCli: allowedTools,
      disallowedToolsCli: disallowedTools,
      baseToolsCli: baseTools,
      permissionMode,
      allowDangerouslySkipPermissions,
      addDirs: addDir
    });
    let toolPermissionContext = initResult.toolPermissionContext;
    const {
      warnings,
      dangerousPermissions,
      overlyBroadBashPermissions
    } = initResult;

    // Handle overly broad shell allow rules for ant users (Bash(*), PowerShell(*))
    if ("external" === 'ant' && overlyBroadBashPermissions.length > 0) {
      for (const permission of overlyBroadBashPermissions) {
        logForDebugging(`Ignoring overly broad shell permission ${permission.ruleDisplay} from ${permission.sourceDisplay}`);
      }
      toolPermissionContext = removeDangerousPermissions(toolPermissionContext, overlyBroadBashPermissions);
    }
    if (feature('TRANSCRIPT_CLASSIFIER') && dangerousPermissions.length > 0) {
      toolPermissionContext = stripDangerousPermissionsForAutoMode(toolPermissionContext);
    }

    // Print any warnings from initialization
    warnings.forEach(warning => {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(warning);
    });
    void assertMinVersion();

    // claude.ai config fetch: -p mode only (interactive uses useManageMCPConnections
    // two-phase loading). Kicked off here to overlap with setup(); awaited
    // before runHeadless so single-turn -p sees connectors. Skipped under
    // enterprise/strict MCP to preserve policy boundaries.
    const claudeaiConfigPromise: Promise<Record<string, ScopedMcpServerConfig>> = isNonInteractiveSession && !strictMcpConfig && !doesEnterpriseMcpConfigExist() &&
    // --bare / SIMPLE: skip claude.ai proxy servers (datadog, Gmail,
    // Slack, BigQuery, PubMed — 6-14s each to connect). Scripted calls
    // that need MCP pass --mcp-config explicitly.
    !isBareMode() ? fetchClaudeAIMcpConfigsIfEligible().then(configs => {
      const {
        allowed,
        blocked
      } = filterMcpServersByPolicy(configs);
      if (blocked.length > 0) {
        process.stderr.write(`Warning: claude.ai MCP ${plural(blocked.length, 'server')} blocked by enterprise policy: ${blocked.join(', ')}\n`);
      }
      return allowed;
    }) : Promise.resolve({});

    // Kick off MCP config loading early (safe - just reads files, no execution).
    // Both interactive and -p use getClaudeCodeMcpConfigs (local file reads only).
    // The local promise is awaited later (before prefetchAllMcpResources) to
    // overlap config I/O with setup(), commands loading, and trust dialog.
    logForDebugging('[STARTUP] Loading MCP configs...');
    const mcpConfigStart = Date.now();
    let mcpConfigResolvedMs: number | undefined;
    // --bare skips auto-discovered MCP (.mcp.json, user settings, plugins) —
    // only explicit --mcp-config works. dynamicMcpConfig is spread onto
    // allMcpConfigs downstream so it survives this skip.
    const mcpConfigPromise = (strictMcpConfig || isBareMode() ? Promise.resolve({
      servers: {} as Record<string, ScopedMcpServerConfig>
    }) : getClaudeCodeMcpConfigs(dynamicMcpConfig)).then(result => {
      mcpConfigResolvedMs = Date.now() - mcpConfigStart;
      return result;
    });

    // NOTE: We do NOT call prefetchAllMcpResources here - that's deferred until after trust dialog

    if (inputFormat && inputFormat !== 'text' && inputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: Invalid input format "${inputFormat}".`);
      process.exit(1);
    }
    if (inputFormat === 'stream-json' && outputFormat !== 'stream-json') {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error: --input-format=stream-json requires output-format=stream-json.`);
      process.exit(1);
    }

    // Validate sdkUrl is only used with appropriate formats (formats are auto-set above)
    if (sdkUrl) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: --sdk-url requires both --input-format=stream-json and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate replayUserMessages is only used with stream-json formats
    if (options.replayUserMessages) {
      if (inputFormat !== 'stream-json' || outputFormat !== 'stream-json') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(`Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate includePartialMessages is only used with print mode and stream-json output
    if (effectiveIncludePartialMessages) {
      if (!isNonInteractiveSession || outputFormat !== 'stream-json') {
        writeToStderr(`Error: --include-partial-messages requires --print and --output-format=stream-json.`);
        process.exit(1);
      }
    }

    // Validate --no-session-persistence is only used with print mode
    if (options.sessionPersistence === false && !isNonInteractiveSession) {
      writeToStderr(`Error: --no-session-persistence can only be used with --print mode.`);
      process.exit(1);
    }
    const effectivePrompt = prompt || '';
    let inputPrompt = await getInputPrompt(effectivePrompt, (inputFormat ?? 'text') as 'text' | 'stream-json');
    profileCheckpoint('action_after_input_prompt');

    // Activate proactive mode BEFORE getTools() so SleepTool.isEnabled()
    // (which returns isProactiveActive()) passes and Sleep is included.
    // The later REPL-path maybeActivateProactive() calls are idempotent.
    maybeActivateProactive(options);
    let tools = getTools(toolPermissionContext);

    // Apply coordinator mode tool filtering for headless path
    // (mirrors useMergedTools.ts filtering for REPL/interactive path)
    if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      const {
        applyCoordinatorToolFilter
      } = await import('./utils/toolPool.js');
      tools = applyCoordinatorToolFilter(tools);
    }
    profileCheckpoint('action_tools_loaded');
    let jsonSchema: ToolInputJSONSchema | undefined;
    if (isSyntheticOutputToolEnabled({
      isNonInteractiveSession
    }) && options.jsonSchema) {
      jsonSchema = jsonParse(options.jsonSchema) as ToolInputJSONSchema;
    }
    if (jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(jsonSchema);
      if ('tool' in syntheticOutputResult) {
        // Add SyntheticOutputTool to the tools array AFTER getTools() filtering.
        // This tool is excluded from normal filtering (see tools.ts) because it's
        // an implementation detail for structured output, not a user-controlled tool.
        tools = [...tools, syntheticOutputResult.tool];
        logEvent('tengu_structured_output_enabled', {
          schema_property_count: Object.keys(jsonSchema.properties as Record<string, unknown> || {}).length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_required_fields: Boolean(jsonSchema.required) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      } else {
        logEvent('tengu_structured_output_failure', {
          error: 'Invalid JSON schema' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });
      }
    }

    // IMPORTANT: setup() must be called before any other code that depends on the cwd or worktree setup
    profileCheckpoint('action_before_setup');
    logForDebugging('[STARTUP] Running setup()...');
    const setupStart = Date.now();
    const {
      setup
    } = await import('./setup.js');
    const messagingSocketPath = feature('UDS_INBOX') ? (options as {
      messagingSocketPath?: string;
    }).messagingSocketPath : undefined;
    // Parallelize setup() with commands+agents loading. setup()'s ~28ms is
    // mostly startUdsMessaging (socket bind, ~20ms) — not disk-bound, so it
    // doesn't contend with getCommands' file reads. Gated on !worktreeEnabled
    // since --worktree makes setup() process.chdir() (setup.ts:203), and
    // commands/agents need the post-chdir cwd.
    const preSetupCwd = getCwd();
    // Register bundled skills/plugins before kicking getCommands() — they're
    // pure in-memory array pushes (<1ms, zero I/O) that getBundledSkills()
    // reads synchronously. Previously ran inside setup() after ~20ms of
    // await points, so the parallel getCommands() memoized an empty list.
    if (process.env.CLAUDE_CODE_ENTRYPOINT !== 'local-agent') {
      initBuiltinPlugins();
      initBundledSkills();
    }
    const setupPromise = setup(preSetupCwd, permissionMode, allowDangerouslySkipPermissions, worktreeEnabled, worktreeName, tmuxEnabled, sessionId ? validateUuid(sessionId) : undefined, worktreePRNumber, messagingSocketPath);
    const commandsPromise = worktreeEnabled ? null : getCommands(preSetupCwd);
    const agentDefsPromise = worktreeEnabled ? null : getAgentDefinitionsWithOverrides(preSetupCwd);
    // Suppress transient unhandledRejection if these reject during the
    // ~28ms setupPromise await before Promise.all joins them below.
    commandsPromise?.catch(() => {});
    agentDefsPromise?.catch(() => {});
    await setupPromise;
    logForDebugging(`[STARTUP] setup() completed in ${Date.now() - setupStart}ms`);
    profileCheckpoint('action_after_setup');

    // Replay user messages into stream-json only when the socket was
    // explicitly requested. The auto-generated socket is passive — it
    // lets tools inject if they want to, but turning it on by default
    // shouldn't reshape stream-json for SDK consumers who never touch it.
    // Callers who inject and also want those injections visible in the
    // stream pass --messaging-socket-path explicitly (or --replay-user-messages).
    let effectiveReplayUserMessages = !!options.replayUserMessages;
    if (feature('UDS_INBOX')) {
      if (!effectiveReplayUserMessages && outputFormat === 'stream-json') {
        effectiveReplayUserMessages = !!(options as {
          messagingSocketPath?: string;
        }).messagingSocketPath;
      }
    }
    if (getIsNonInteractiveSession()) {
      // Apply full merged settings env now (including project-scoped
      // .claude/settings.json PATH/GIT_DIR/GIT_WORK_TREE) so gitExe() and
      // the git spawn below see it. Trust is implicit in -p mode; the
      // docstring at managedEnv.ts:96-97 says this applies "potentially
      // dangerous environment variables such as LD_PRELOAD, PATH" from all
      // sources. The later call in the isNonInteractiveSession block below
      // is idempotent (Object.assign, configureGlobalAgents ejects prior
      // interceptor) and picks up any plugin-contributed env after plugin
      // init. Project settings are already loaded here:
      // applySafeConfigEnvironmentVariables in init() called
      // getSettings_DEPRECATED at managedEnv.ts:86 which merges all enabled
      // sources including projectSettings/localSettings.
      applyConfigEnvironmentVariables();

      // Spawn git status/log/branch now so the subprocess execution overlaps
      // with the getCommands await below and startDeferredPrefetches. After
      // setup() so cwd is final (setup.ts:254 may process.chdir(worktreePath)
      // for --worktree) and after the applyConfigEnvironmentVariables above
      // so PATH/GIT_DIR/GIT_WORK_TREE from all sources (trusted + project)
      // are applied. getSystemContext is memoized; the
      // prefetchSystemContextIfSafe call in startDeferredPrefetches becomes
      // a cache hit. The microtask from await getIsGit() drains at the
      // getCommands Promise.all await below. Trust is implicit in -p mode
      // (same gate as prefetchSystemContextIfSafe).
      void getSystemContext();
      // Kick getUserContext now too — its first await (fs.readFile in
      // getMemoryFiles) yields naturally, so the CLAUDE.md directory walk
      // runs during the ~280ms overlap window before the context
      // Promise.all join in print.ts. The void getUserContext() in
      // startDeferredPrefetches becomes a memoize cache-hit.
      void getUserContext();
      // Kick ensureModelStringsInitialized now — for Bedrock this triggers
      // a 100-200ms profile fetch that was awaited serially at
      // print.ts:739. updateBedrockModelStrings is sequential()-wrapped so
      // the await joins the in-flight fetch. Non-Bedrock is a sync
      // early-return (zero-cost).
      void ensureModelStringsInitialized();
    }

    // Apply --name: cache-only so no orphan file is created before the
    // session ID is finalized by --continue/--resume. materializeSessionFile
    // persists it on the first user message; REPL's useTerminalTitle reads it
    // via getCurrentSessionTitle.
    const sessionNameArg = options.name?.trim();
    if (sessionNameArg) {
      cacheSessionTitle(sessionNameArg);
    }

    // Ant model aliases (capybara-fast etc.) resolve via the
    // tengu_ant_model_override GrowthBook flag. _CACHED_MAY_BE_STALE reads
    // disk synchronously; disk is populated by a fire-and-forget write. On a
    // cold cache, parseUserSpecifiedModel returns the unresolved alias, the
    // API 404s, and -p exits before the async write lands — crashloop on
    // fresh pods. Awaiting init here populates the in-memory payload map that
    // _CACHED_MAY_BE_STALE now checks first. Gated so the warm path stays
    // non-blocking:
    //  - explicit model via --model or ANTHROPIC_MODEL (both feed alias resolution)
    //  - no env override (which short-circuits _CACHED_MAY_BE_STALE before disk)
    //  - flag absent from disk (== null also catches pre-#22279 poisoned null)
    const explicitModel = options.model || process.env.ANTHROPIC_MODEL;
    if ("external" === 'ant' && explicitModel && explicitModel !== 'default' && !hasGrowthBookEnvOverride('tengu_ant_model_override') && getGlobalConfig().cachedGrowthBookFeatures?.['tengu_ant_model_override'] == null) {
      await initializeGrowthBook();
    }

    // Special case the default model with the null keyword
    // NOTE: Model resolution happens after setup() to ensure trust is established before AWS auth
    const userSpecifiedModel = options.model === 'default' ? getDefaultMainLoopModel() : options.model;
    const userSpecifiedFallbackModel = fallbackModel === 'default' ? getDefaultMainLoopModel() : fallbackModel;

    // Reuse preSetupCwd unless setup() chdir'd (worktreeEnabled). Saves a
    // getCwd() syscall in the common path.
    const currentCwd = worktreeEnabled ? getCwd() : preSetupCwd;
    logForDebugging('[STARTUP] Loading commands and agents...');
    const commandsStart = Date.now();
    // Join the promises kicked before setup() (or start fresh if
    // worktreeEnabled gated the early kick). Both memoized by cwd.
    const [commands, agentDefinitionsResult] = await Promise.all([commandsPromise ?? getCommands(currentCwd), agentDefsPromise ?? getAgentDefinitionsWithOverrides(currentCwd)]);
    logForDebugging(`[STARTUP] Commands and agents loaded in ${Date.now() - commandsStart}ms`);
    profileCheckpoint('action_commands_loaded');

    // Parse CLI agents if provided via --agents flag
    let cliAgents: typeof agentDefinitionsResult.activeAgents = [];
    if (agentsJson) {
      try {
        const parsedAgents = safeParseJSON(agentsJson);
        if (parsedAgents) {
          cliAgents = parseAgentsFromJson(parsedAgents, 'flagSettings');
        }
      } catch (error) {
        logError(error);
      }
    }

    // Merge CLI agents with existing ones
    const allAgents = [...agentDefinitionsResult.allAgents, ...cliAgents];
    const agentDefinitions = {
      ...agentDefinitionsResult,
      allAgents,
      activeAgents: getActiveAgentsFromList(allAgents)
    };

    // Look up main thread agent from CLI flag or settings
    const agentSetting = agentCli ?? getInitialSettings().agent;
    let mainThreadAgentDefinition: (typeof agentDefinitions.activeAgents)[number] | undefined;
    if (agentSetting) {
      mainThreadAgentDefinition = agentDefinitions.activeAgents.find(agent => agent.agentType === agentSetting);
      if (!mainThreadAgentDefinition) {
        logForDebugging(`Warning: agent "${agentSetting}" not found. ` + `Available agents: ${agentDefinitions.activeAgents.map(a => a.agentType).join(', ')}. ` + `Using default behavior.`);
      }
    }

    // Store the main thread agent type in bootstrap state so hooks can access it
    setMainThreadAgentType(mainThreadAgentDefinition?.agentType);

    // Log agent flag usage — only log agent name for built-in agents to avoid leaking custom agent names
    if (mainThreadAgentDefinition) {
      logEvent('tengu_agent_flag', {
        agentType: isBuiltInAgent(mainThreadAgentDefinition) ? mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS : 'custom' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(agentCli && {
          source: 'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        })
      });
    }

    // Persist agent setting to session transcript for resume view display and restoration
    if (mainThreadAgentDefinition?.agentType) {
      saveAgentSetting(mainThreadAgentDefinition.agentType);
    }

    // Apply the agent's system prompt for non-interactive sessions
    // (interactive mode uses buildEffectiveSystemPrompt instead)
    if (isNonInteractiveSession && mainThreadAgentDefinition && !systemPrompt && !isBuiltInAgent(mainThreadAgentDefinition)) {
      const agentSystemPrompt = mainThreadAgentDefinition.getSystemPrompt();
      if (agentSystemPrompt) {
        systemPrompt = agentSystemPrompt;
      }
    }

    // initialPrompt goes first so its slash command (if any) is processed;
    // user-provided text becomes trailing context.
    // Only concatenate when inputPrompt is a string. When it's an
    // AsyncIterable (SDK stream-json mode), template interpolation would
    // call .toString() producing "[object Object]". The AsyncIterable case
    // is handled in print.ts via structuredIO.prependUserMessage().
    if (mainThreadAgentDefinition?.initialPrompt) {
      if (typeof inputPrompt === 'string') {
        inputPrompt = inputPrompt ? `${mainThreadAgentDefinition.initialPrompt}\n\n${inputPrompt}` : mainThreadAgentDefinition.initialPrompt;
      } else if (!inputPrompt) {
        inputPrompt = mainThreadAgentDefinition.initialPrompt;
      }
    }

    // Compute effective model early so hooks can run in parallel with MCP
    // If user didn't specify a model but agent has one, use the agent's model
    let effectiveModel = userSpecifiedModel;
    if (!effectiveModel && mainThreadAgentDefinition?.model && mainThreadAgentDefinition.model !== 'inherit') {
      effectiveModel = parseUserSpecifiedModel(mainThreadAgentDefinition.model);
    }
    setMainLoopModelOverride(effectiveModel);

    // Compute resolved model for hooks (use user-specified model at launch)
    setInitialMainLoopModel(getUserSpecifiedModelSetting() || null);
    const initialMainLoopModel = getInitialMainLoopModel();
    const resolvedInitialModel = parseUserSpecifiedModel(initialMainLoopModel ?? getDefaultMainLoopModel());
    let advisorModel: string | undefined;
    if (isAdvisorEnabled()) {
      const advisorOption = canUserConfigureAdvisor() ? (options as {
        advisor?: string;
      }).advisor : undefined;
      if (advisorOption) {
        logForDebugging(`[AdvisorTool] --advisor ${advisorOption}`);
        if (!modelSupportsAdvisor(resolvedInitialModel)) {
          process.stderr.write(chalk.red(`Error: The model "${resolvedInitialModel}" does not support the advisor tool.\n`));
          process.exit(1);
        }
        const normalizedAdvisorModel = normalizeModelStringForAPI(parseUserSpecifiedModel(advisorOption));
        if (!isValidAdvisorModel(normalizedAdvisorModel)) {
          process.stderr.write(chalk.red(`Error: The model "${advisorOption}" cannot be used as an advisor.\n`));
          process.exit(1);
        }
      }
      advisorModel = canUserConfigureAdvisor() ? advisorOption ?? getInitialAdvisorSetting() : advisorOption;
      if (advisorModel) {
        logForDebugging(`[AdvisorTool] Advisor model: ${advisorModel}`);
      }
    }

    // For tmux teammates with --agent-type, append the custom agent's prompt
    if (isAgentSwarmsEnabled() && storedTeammateOpts?.agentId && storedTeammateOpts?.agentName && storedTeammateOpts?.teamName && storedTeammateOpts?.agentType) {
      // Look up the custom agent definition
      const customAgent = agentDefinitions.activeAgents.find(a => a.agentType === storedTeammateOpts.agentType);
      if (customAgent) {
        // Get the prompt - need to handle both built-in and custom agents
        let customPrompt: string | undefined;
        if (customAgent.source === 'built-in') {
          // Built-in agents have getSystemPrompt that takes toolUseContext
          // We can't access full toolUseContext here, so skip for now
          logForDebugging(`[teammate] Built-in agent ${storedTeammateOpts.agentType} - skipping custom prompt (not supported)`);
        } else {
          // Custom agents have getSystemPrompt that takes no args
          customPrompt = customAgent.getSystemPrompt();
        }

        // Log agent memory loaded event for tmux teammates
        if (customAgent.memory) {
          logEvent('tengu_agent_memory_loaded', {
            ...("external" === 'ant' && {
              agent_type: customAgent.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
            }),
            scope: customAgent.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            source: 'teammate' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
        }
        if (customPrompt) {
          const customInstructions = `\n# Custom Agent Instructions\n${customPrompt}`;
          appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${customInstructions}` : customInstructions;
        }
      } else {
        logForDebugging(`[teammate] Custom agent ${storedTeammateOpts.agentType} not found in available agents`);
      }
    }
    maybeActivateBrief(options);
    // defaultView: 'chat' is a persisted opt-in — check entitlement and set
    // userMsgOptIn so the tool + prompt section activate. Interactive-only:
    // defaultView is a display preference; SDK sessions have no display, and
    // the assistant installer writes defaultView:'chat' to settings.local.json
    // which would otherwise leak into --print sessions in the same directory.
    // Runs right after maybeActivateBrief() so all startup opt-in paths fire
    // BEFORE any isBriefEnabled() read below (proactive prompt's
    // briefVisibility). A persisted 'chat' after a GB kill-switch falls
    // through (entitlement fails).
    if ((feature('KAIROS') || feature('KAIROS_BRIEF')) && !getIsNonInteractiveSession() && !getUserMsgOptIn() && getInitialSettings().defaultView === 'chat') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        isBriefEntitled
      } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      if (isBriefEntitled()) {
        setUserMsgOptIn(true);
      }
    }
    // Coordinator mode has its own system prompt and filters out Sleep, so
    // the generic proactive prompt would tell it to call a tool it can't
    // access and conflict with delegation instructions.
    if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
      proactive?: boolean;
    }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE)) && !coordinatorModeModule?.isCoordinatorMode()) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const briefVisibility = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js')).isBriefEnabled() ? 'Call SendUserMessage at checkpoints to mark where things stand.' : 'The user will see any text you output.' : 'The user will see any text you output.';
      /* eslint-enable @typescript-eslint/no-require-imports */
      const proactivePrompt = `\n# Proactive Mode\n\nYou are in proactive mode. Take initiative — explore, act, and make progress without waiting for instructions.\n\nStart by briefly greeting the user.\n\nYou will receive periodic <tick> prompts. These are check-ins. Do whatever seems most useful, or call Sleep if there's nothing to do. ${briefVisibility}`;
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${proactivePrompt}` : proactivePrompt;
    }
    if (feature('KAIROS') && kairosEnabled && assistantModule) {
      const assistantAddendum = assistantModule.getAssistantSystemPromptAddendum();
      appendSystemPrompt = appendSystemPrompt ? `${appendSystemPrompt}\n\n${assistantAddendum}` : assistantAddendum;
    }

    // Ink root is only needed for interactive sessions — patchConsole in the
    // Ink constructor would swallow console output in headless mode.
    let root!: Root;
    let getFpsMetrics!: () => FpsMetrics | undefined;
    let stats!: StatsStore;

    // Show setup screens after commands are loaded
    if (!isNonInteractiveSession) {
      const ctx = getRenderContext(false);
      getFpsMetrics = ctx.getFpsMetrics;
      stats = ctx.stats;
      // Install asciicast recorder before Ink mounts (ant-only, opt-in via CLAUDE_CODE_TERMINAL_RECORDING=1)
      if ("external" === 'ant') {
        installAsciicastRecorder();
      }
      const {
        createRoot
      } = await import('./ink.js');
      root = await createRoot(ctx.renderOptions);

      // Log startup time now, before any blocking dialog renders. Logging
      // from REPL's first render (the old location) included however long
      // the user sat on trust/OAuth/onboarding/resume-picker — p99 was ~70s
      // dominated by dialog-wait time, not code-path startup.
      logEvent('tengu_timer', {
        event: 'startup' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs: Math.round(process.uptime() * 1000)
      });
      logForDebugging('[STARTUP] Running showSetupScreens()...');
      const setupScreensStart = Date.now();
      const onboardingShown = await showSetupScreens(root, permissionMode, allowDangerouslySkipPermissions, commands, enableClaudeInChrome, devChannels);
      logForDebugging(`[STARTUP] showSetupScreens() completed in ${Date.now() - setupScreensStart}ms`);

      // Now that trust is established and GrowthBook has auth headers,
      // resolve the --remote-control / --rc entitlement gate.
      if (feature('BRIDGE_MODE') && remoteControlOption !== undefined) {
        const {
          getBridgeDisabledReason
        } = await import('./bridge/bridgeEnabled.js');
        const disabledReason = await getBridgeDisabledReason();
        remoteControl = disabledReason === null;
        if (disabledReason) {
          process.stderr.write(chalk.yellow(`${disabledReason}\n--rc flag ignored.\n`));
        }
      }

      // Check for pending agent memory snapshot updates (only for --agent mode, ant-only)
      if (feature('AGENT_MEMORY_SNAPSHOT') && mainThreadAgentDefinition && isCustomAgent(mainThreadAgentDefinition) && mainThreadAgentDefinition.memory && mainThreadAgentDefinition.pendingSnapshotUpdate) {
        const agentDef = mainThreadAgentDefinition;
        const choice = await launchSnapshotUpdateDialog(root, {
          agentType: agentDef.agentType,
          scope: agentDef.memory!,
          snapshotTimestamp: agentDef.pendingSnapshotUpdate!.snapshotTimestamp
        });
        if (choice === 'merge') {
          const {
            buildMergePrompt
          } = await import('./components/agents/SnapshotUpdateDialog.js');
          const mergePrompt = buildMergePrompt(agentDef.agentType, agentDef.memory!);
          inputPrompt = inputPrompt ? `${mergePrompt}\n\n${inputPrompt}` : mergePrompt;
        }
        agentDef.pendingSnapshotUpdate = undefined;
      }

      // Skip executing /login if we just completed onboarding for it
      if (onboardingShown && prompt?.trim().toLowerCase() === '/login') {
        prompt = '';
      }
      if (onboardingShown) {
        // Refresh auth-dependent services now that the user has logged in during onboarding.
        // Keep in sync with the post-login logic in src/commands/login.tsx
        void refreshRemoteManagedSettings();
        void refreshPolicyLimits();
        // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
        resetUserCache();
        // Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
        refreshGrowthBookAfterAuthChange();
        // Clear any stale trusted device token then enroll for Remote Control.
        // Both self-gate on tengu_sessions_elevated_auth_enforcement internally
        // — enrollTrustedDevice() via checkGate_CACHED_OR_BLOCKING (awaits
        // the GrowthBook reinit above), clearTrustedDeviceToken() via the
        // sync cached check (acceptable since clear is idempotent).
        void import('./bridge/trustedDevice.js').then(m => {
          m.clearTrustedDeviceToken();
          return m.enrollTrustedDevice();
        });
      }

      // Validate that the active token's org matches forceLoginOrgUUID (if set
      // in managed settings). Runs after onboarding so managed settings and
      // login state are fully loaded.
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        await exitWithError(root, orgValidation.message);
      }
    }

    // If gracefulShutdown was initiated (e.g., user rejected trust dialog),
    // process.exitCode will be set. Skip all subsequent operations that could
    // trigger code execution before the process exits (e.g. we don't want apiKeyHelper
    // to run if trust was not established).
    if (process.exitCode !== undefined) {
      logForDebugging('Graceful shutdown initiated, skipping further initialization');
      return;
    }

    // Initialize LSP manager AFTER trust is established (or in non-interactive mode
    // where trust is implicit). This prevents plugin LSP servers from executing
    // code in untrusted directories before user consent.
    // Must be after inline plugins are set (if any) so --plugin-dir LSP servers are included.
    initializeLspServerManager();

    // Show settings validation errors after trust is established
    // MCP config errors don't block settings from loading, so exclude them
    if (!isNonInteractiveSession) {
      const {
        errors
      } = getSettingsWithErrors();
      const nonMcpErrors = errors.filter(e => !e.mcpErrorMetadata);
      if (nonMcpErrors.length > 0) {
        await launchInvalidSettingsDialog(root, {
          settingsErrors: nonMcpErrors,
          onExit: () => gracefulShutdownSync(1)
        });
      }
    }

    // Check quota status, fast mode, passes eligibility, and bootstrap data
    // after trust is established. These make API calls which could trigger
    // apiKeyHelper execution.
    // --bare / SIMPLE: skip — these are cache-warms for the REPL's
    // first-turn responsiveness (quota, passes, fastMode, bootstrap data). Fast
    // mode doesn't apply to the Agent SDK anyway (see getFastModeUnavailableReason).
    const bgRefreshThrottleMs = getFeatureValue_CACHED_MAY_BE_STALE('tengu_cicada_nap_ms', 0);
    const lastPrefetched = getGlobalConfig().startupPrefetchedAt ?? 0;
    const skipStartupPrefetches = isBareMode() || bgRefreshThrottleMs > 0 && Date.now() - lastPrefetched < bgRefreshThrottleMs;
    if (!skipStartupPrefetches) {
      const lastPrefetchedInfo = lastPrefetched > 0 ? ` last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago` : '';
      logForDebugging(`Starting background startup prefetches${lastPrefetchedInfo}`);
      checkQuotaStatus().catch(error => logError(error));

      // Fetch bootstrap data from the server and update all cache values.
      void fetchBootstrapData();

      // TODO: Consolidate other prefetches into a single bootstrap request.
      void prefetchPassesEligibility();
      if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_miraculo_the_bard', false)) {
        void prefetchFastModeStatus();
      } else {
        // Kill switch skips the network call, not org-policy enforcement.
        // Resolve from cache so orgStatus doesn't stay 'pending' (which
        // getFastModeUnavailableReason treats as permissive).
        resolveFastModeStatusFromCache();
      }
      if (bgRefreshThrottleMs > 0) {
        saveGlobalConfig(current => ({
          ...current,
          startupPrefetchedAt: Date.now()
        }));
      }
    } else {
      logForDebugging(`Skipping startup prefetches, last ran ${Math.round((Date.now() - lastPrefetched) / 1000)}s ago`);
      // Resolve fast mode org status from cache (no network)
      resolveFastModeStatusFromCache();
    }
    if (!isNonInteractiveSession) {
      void refreshExampleCommands(); // Pre-fetch example commands (runs git log, no API call)
    }

    // Resolve MCP configs (started early, overlaps with setup/trust dialog work)
    const {
      servers: existingMcpConfigs
    } = await mcpConfigPromise;
    logForDebugging(`[STARTUP] MCP configs resolved in ${mcpConfigResolvedMs}ms (awaited at +${Date.now() - mcpConfigStart}ms)`);
    // CLI flag (--mcp-config) should override file-based configs, matching settings precedence
    const allMcpConfigs = {
      ...existingMcpConfigs,
      ...dynamicMcpConfig
    };

    // Separate SDK configs from regular MCP configs
    const sdkMcpConfigs: Record<string, McpSdkServerConfig> = {};
    const regularMcpConfigs: Record<string, ScopedMcpServerConfig> = {};
    for (const [name, config] of Object.entries(allMcpConfigs)) {
      const typedConfig = config as ScopedMcpServerConfig | McpSdkServerConfig;
      if (typedConfig.type === 'sdk') {
        sdkMcpConfigs[name] = typedConfig as McpSdkServerConfig;
      } else {
        regularMcpConfigs[name] = typedConfig as ScopedMcpServerConfig;
      }
    }
    profileCheckpoint('action_mcp_configs_loaded');

    // Prefetch MCP resources after trust dialog (this is where execution happens).
    // Interactive mode only: print mode defers connects until headlessStore exists
    // and pushes per-server (below), so ToolSearch's pending-client handling works
    // and one slow server doesn't block the batch.
    const localMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : prefetchAllMcpResources(regularMcpConfigs);
    const claudeaiMcpPromise = isNonInteractiveSession ? Promise.resolve({
      clients: [],
      tools: [],
      commands: []
    }) : claudeaiConfigPromise.then(configs => Object.keys(configs).length > 0 ? prefetchAllMcpResources(configs) : {
      clients: [],
      tools: [],
      commands: []
    });
    // Merge with dedup by name: each prefetchAllMcpResources call independently
    // adds helper tools (ListMcpResourcesTool, ReadMcpResourceTool) via
    // local dedup flags, so merging two calls can yield duplicates. print.ts
    // already uniqBy's the final tool pool, but dedup here keeps appState clean.
    const mcpPromise = Promise.all([localMcpPromise, claudeaiMcpPromise]).then(([local, claudeai]) => ({
      clients: [...local.clients, ...claudeai.clients],
      tools: uniqBy([...local.tools, ...claudeai.tools], 'name'),
      commands: uniqBy([...local.commands, ...claudeai.commands], 'name')
    }));

    // Start hooks early so they run in parallel with MCP connections.
    // Skip for initOnly/init/maintenance (handled separately), non-interactive
    // (handled via setupTrigger), and resume/continue (conversationRecovery.ts
    // fires 'resume' instead — without this guard, hooks fire TWICE on /resume
    // and the second systemMessage clobbers the first. gh-30825)
    const hooksPromise = initOnly || init || maintenance || isNonInteractiveSession || options.continue || options.resume ? null : processSessionStartHooks('startup', {
      agentType: mainThreadAgentDefinition?.agentType,
      model: resolvedInitialModel
    });

    // MCP never blocks REPL render OR turn 1 TTFT. useManageMCPConnections
    // populates appState.mcp async as servers connect (connectToServer is
    // memoized — the prefetch calls above and the hook converge on the same
    // connections). getToolUseContext reads store.getState() fresh via
    // computeTools(), so turn 1 sees whatever's connected by query time.
    // Slow servers populate for turn 2+. Matches interactive-no-prompt
    // behavior. Print mode: per-server push into headlessStore (below).
    const hookMessages: Awaited<NonNullable<typeof hooksPromise>> = [];
    // Suppress transient unhandledRejection — the prefetch warms the
    // memoized connectToServer cache but nobody awaits it in interactive.
    mcpPromise.catch(() => {});
    const mcpClients: Awaited<typeof mcpPromise>['clients'] = [];
    const mcpTools: Awaited<typeof mcpPromise>['tools'] = [];
    const mcpCommands: Awaited<typeof mcpPromise>['commands'] = [];
    let thinkingEnabled = shouldEnableThinkingByDefault();
    let thinkingConfig: ThinkingConfig = thinkingEnabled !== false ? {
      type: 'adaptive'
    } : {
      type: 'disabled'
    };
    if (options.thinking === 'adaptive' || options.thinking === 'enabled') {
      thinkingEnabled = true;
      thinkingConfig = {
        type: 'adaptive'
      };
    } else if (options.thinking === 'disabled') {
      thinkingEnabled = false;
      thinkingConfig = {
        type: 'disabled'
      };
    } else {
      const maxThinkingTokens = process.env.MAX_THINKING_TOKENS ? parseInt(process.env.MAX_THINKING_TOKENS, 10) : options.maxThinkingTokens;
      if (maxThinkingTokens !== undefined) {
        if (maxThinkingTokens > 0) {
          thinkingEnabled = true;
          thinkingConfig = {
            type: 'enabled',
            budgetTokens: maxThinkingTokens
          };
        } else if (maxThinkingTokens === 0) {
          thinkingEnabled = false;
          thinkingConfig = {
            type: 'disabled'
          };
        }
      }
    }
    logForDiagnosticsNoPII('info', 'started', {
      version: MACRO.VERSION,
      is_native_binary: isInBundledMode()
    });
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'exited');
    });
    void logTenguInit({
      hasInitialPrompt: Boolean(prompt),
      hasStdin: Boolean(inputPrompt),
      verbose,
      debug,
      debugToStderr,
      print: print ?? false,
      outputFormat: outputFormat ?? 'text',
      inputFormat: inputFormat ?? 'text',
      numAllowedTools: allowedTools.length,
      numDisallowedTools: disallowedTools.length,
      mcpClientCount: Object.keys(allMcpConfigs).length,
      worktreeEnabled,
      skipWebFetchPreflight: getInitialSettings().skipWebFetchPreflight,
      githubActionInputs: process.env.GITHUB_ACTION_INPUTS,
      dangerouslySkipPermissionsPassed: dangerouslySkipPermissions ?? false,
      permissionMode,
      modeIsBypass: permissionMode === 'bypassPermissions',
      allowDangerouslySkipPermissionsPassed: allowDangerouslySkipPermissions,
      systemPromptFlag: systemPrompt ? options.systemPromptFile ? 'file' : 'flag' : undefined,
      appendSystemPromptFlag: appendSystemPrompt ? options.appendSystemPromptFile ? 'file' : 'flag' : undefined,
      thinkingConfig,
      assistantActivationPath: feature('KAIROS') && kairosEnabled ? assistantModule?.getAssistantActivationPath() : undefined
    });

    // Log context metrics once at initialization
    void logContextMetrics(regularMcpConfigs, toolPermissionContext);
    void logPermissionContextForAnts(null, 'initialization');
    logManagedSettings();

    // Register PID file for concurrent-session detection (~/.claude/sessions/)
    // and fire multi-clauding telemetry. Lives here (not init.ts) so only the
    // REPL path registers — not subcommands like `claude doctor`. Chained:
    // count must run after register's write completes or it misses our own file.
    void registerSession().then(registered => {
      if (!registered) return;
      if (sessionNameArg) {
        void updateSessionName(sessionNameArg);
      }
      void countConcurrentSessions().then(count => {
        if (count >= 2) {
          logEvent('tengu_concurrent_sessions', {
            num_sessions: count
          });
        }
      });
    });

    // Initialize versioned plugins system (triggers V1→V2 migration if
    // needed). Then run orphan GC, THEN warm the Grep/Glob exclusion cache.
    // Sequencing matters: the warmup scans disk for .orphaned_at markers,
    // so it must see the GC's Pass 1 (remove markers from reinstalled
    // versions) and Pass 2 (stamp unmarked orphans) already applied. The
    // warm also lands before autoupdate (fires on first submit in REPL)
    // can orphan this session's active version underneath us.
    // --bare / SIMPLE: skip plugin version sync + orphan cleanup. These
    // are install/upgrade bookkeeping that scripted calls don't need —
    // the next interactive session will reconcile. The await here was
    // blocking -p on a marketplace round-trip.
    if (isBareMode()) {
      // skip — no-op
    } else if (isNonInteractiveSession) {
      // In headless mode, await to ensure plugin sync completes before CLI exits
      await initializeVersionedPlugins();
      profileCheckpoint('action_after_plugins_init');
      void cleanupOrphanedPluginVersionsInBackground().then(() => getGlobExclusionsForPluginCache());
    } else {
      // In interactive mode, fire-and-forget — this is purely bookkeeping
      // that doesn't affect runtime behavior of the current session
      void initializeVersionedPlugins().then(async () => {
        profileCheckpoint('action_after_plugins_init');
        await cleanupOrphanedPluginVersionsInBackground();
        void getGlobExclusionsForPluginCache();
      });
    }
    const setupTrigger = initOnly || init ? 'init' : maintenance ? 'maintenance' : null;
    if (initOnly) {
      applyConfigEnvironmentVariables();
      await processSetupHooks('init', {
        forceSyncExecution: true
      });
      await processSessionStartHooks('startup', {
        forceSyncExecution: true
      });
      gracefulShutdownSync(0);
      return;
    }

    // --print mode
    if (isNonInteractiveSession) {
      if (outputFormat === 'stream-json' || outputFormat === 'json') {
        setHasFormattedOutput(true);
      }

      // Apply full environment variables in print mode since trust dialog is bypassed
      // This includes potentially dangerous environment variables from untrusted sources
      // but print mode is considered trusted (as documented in help text)
      applyConfigEnvironmentVariables();

      // Initialize telemetry after env vars are applied so OTEL endpoint env vars and
      // otelHeadersHelper (which requires trust to execute) are available.
      initializeTelemetryAfterTrust();

      // Kick SessionStart hooks now so the subprocess spawn overlaps with
      // MCP connect + plugin init + print.ts import below. loadInitialMessages
      // joins this at print.ts:4397. Guarded same as loadInitialMessages —
      // continue/resume/teleport paths don't fire startup hooks (or fire them
      // conditionally inside the resume branch, where this promise is
      // undefined and the ?? fallback runs). Also skip when setupTrigger is
      // set — those paths run setup hooks first (print.ts:544), and session
      // start hooks must wait until setup completes.
      const sessionStartHooksPromise = options.continue || options.resume || teleport || setupTrigger ? undefined : processSessionStartHooks('startup');
      // Suppress transient unhandledRejection if this rejects before
      // loadInitialMessages awaits it. Downstream await still observes the
      // rejection — this just prevents the spurious global handler fire.
      sessionStartHooksPromise?.catch(() => {});
      profileCheckpoint('before_validateForceLoginOrg');
      // Validate org restriction for non-interactive sessions
      const orgValidation = await validateForceLoginOrg();
      if (!orgValidation.valid) {
        process.stderr.write(orgValidation.message + '\n');
        process.exit(1);
      }

      // Headless mode supports all prompt commands and some local commands
      // If disableSlashCommands is true, return empty array
      const commandsHeadless = disableSlashCommands ? [] : commands.filter(command => command.type === 'prompt' && !command.disableNonInteractive || command.type === 'local' && command.supportsNonInteractive);
      const defaultState = getDefaultAppState();
      const headlessInitialState: AppState = {
        ...defaultState,
        mcp: {
          ...defaultState.mcp,
          clients: mcpClients,
          commands: mcpCommands,
          tools: mcpTools
        },
        toolPermissionContext,
        effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
        ...(isFastModeEnabled() && {
          fastMode: getInitialFastModeSetting(effectiveModel ?? null)
        }),
        ...(isAdvisorEnabled() && advisorModel && {
          advisorModel
        }),
        // kairosEnabled gates the async fire-and-forget path in
        // executeForkedSlashCommand (processSlashCommand.tsx:132) and
        // AgentTool's shouldRunAsync. The REPL initialState sets this at
        // ~3459; headless was defaulting to false, so the daemon child's
        // scheduled tasks and Agent-tool calls ran synchronously — N
        // overdue cron tasks on spawn = N serial subagent turns blocking
        // user input. Computed at :1620, well before this branch.
        ...(feature('KAIROS') ? {
          kairosEnabled
        } : {})
      };

      // Init app state
      const headlessStore = createStore(headlessInitialState, onChangeAppState);

      // Check if bypassPermissions should be disabled based on Statsig gate
      // This runs in parallel to the code below, to avoid blocking the main loop.
      if (toolPermissionContext.mode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
        void checkAndDisableBypassPermissions(toolPermissionContext);
      }

      // Async check of auto mode gate — corrects state and disables auto if needed.
      // Gated on TRANSCRIPT_CLASSIFIER (not USER_TYPE) so GrowthBook kill switch runs for external builds too.
      if (feature('TRANSCRIPT_CLASSIFIER')) {
        void verifyAutoModeGateAccess(toolPermissionContext, headlessStore.getState().fastMode).then(({
          updateContext
        }) => {
          headlessStore.setState(prev => {
            const nextCtx = updateContext(prev.toolPermissionContext);
            if (nextCtx === prev.toolPermissionContext) return prev;
            return {
              ...prev,
              toolPermissionContext: nextCtx
            };
          });
        });
      }

      // Set global state for session persistence
      if (options.sessionPersistence === false) {
        setSessionPersistenceDisabled(true);
      }

      // Store SDK betas in global state for context window calculation
      // Only store allowed betas (filters by allowlist and subscriber status)
      setSdkBetas(filterAllowedSdkBetas(betas));

      // Print-mode MCP: per-server incremental push into headlessStore.
      // Mirrors useManageMCPConnections — push pending first (so ToolSearch's
      // pending-check at ToolSearchTool.ts:334 sees them), then replace with
      // connected/failed as each server settles.
      const connectMcpBatch = (configs: Record<string, ScopedMcpServerConfig>, label: string): Promise<void> => {
        if (Object.keys(configs).length === 0) return Promise.resolve();
        headlessStore.setState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            clients: [...prev.mcp.clients, ...Object.entries(configs).map(([name, config]) => ({
              name,
              type: 'pending' as const,
              config
            }))]
          }
        }));
        return getMcpToolsCommandsAndResources(({
          client,
          tools,
          commands
        }) => {
          headlessStore.setState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.some(c => c.name === client.name) ? prev.mcp.clients.map(c => c.name === client.name ? client : c) : [...prev.mcp.clients, client],
              tools: uniqBy([...prev.mcp.tools, ...tools], 'name'),
              commands: uniqBy([...prev.mcp.commands, ...commands], 'name')
            }
          }));
        }, configs).catch(err => logForDebugging(`[MCP] ${label} connect error: ${err}`));
      };
      // Await all MCP configs — print mode is often single-turn, so
      // "late-connecting servers visible next turn" doesn't help. SDK init
      // message and turn-1 tool list both need configured MCP tools present.
      // Zero-server case is free via the early return in connectMcpBatch.
      // Connectors parallelize inside getMcpToolsCommandsAndResources
      // (processBatched with Promise.all). claude.ai is awaited too — its
      // fetch was kicked off early (line ~2558) so only residual time blocks
      // here. --bare skips claude.ai entirely for perf-sensitive scripts.
      profileCheckpoint('before_connectMcp');
      await connectMcpBatch(regularMcpConfigs, 'regular');
      profileCheckpoint('after_connectMcp');
      // Dedup: suppress plugin MCP servers that duplicate a claude.ai
      // connector (connector wins), then connect claude.ai servers.
      // Bounded wait — #23725 made this blocking so single-turn -p sees
      // connectors, but with 40+ slow connectors tengu_startup_perf p99
      // climbed to 76s. If fetch+connect doesn't finish in time, proceed;
      // the promise keeps running and updates headlessStore in the
      // background so turn 2+ still sees connectors.
      const CLAUDE_AI_MCP_TIMEOUT_MS = 5_000;
      const claudeaiConnect = claudeaiConfigPromise.then(claudeaiConfigs => {
        if (Object.keys(claudeaiConfigs).length > 0) {
          const claudeaiSigs = new Set<string>();
          for (const config of Object.values(claudeaiConfigs)) {
            const sig = getMcpServerSignature(config);
            if (sig) claudeaiSigs.add(sig);
          }
          const suppressed = new Set<string>();
          for (const [name, config] of Object.entries(regularMcpConfigs)) {
            if (!name.startsWith('plugin:')) continue;
            const sig = getMcpServerSignature(config);
            if (sig && claudeaiSigs.has(sig)) suppressed.add(name);
          }
          if (suppressed.size > 0) {
            logForDebugging(`[MCP] Lazy dedup: suppressing ${suppressed.size} plugin server(s) that duplicate claude.ai connectors: ${[...suppressed].join(', ')}`);
            // Disconnect before filtering from state. Only connected
            // servers need cleanup — clearServerCache on a never-connected
            // server triggers a real connect just to kill it (memoize
            // cache-miss path, see useManageMCPConnections.ts:870).
            for (const c of headlessStore.getState().mcp.clients) {
              if (!suppressed.has(c.name) || c.type !== 'connected') continue;
              c.client.onclose = undefined;
              void clearServerCache(c.name, c.config).catch(() => {});
            }
            headlessStore.setState(prev => {
              let {
                clients,
                tools,
                commands,
                resources
              } = prev.mcp;
              clients = clients.filter(c => !suppressed.has(c.name));
              tools = tools.filter(t => !t.mcpInfo || !suppressed.has(t.mcpInfo.serverName));
              for (const name of suppressed) {
                commands = excludeCommandsByServer(commands, name);
                resources = excludeResourcesByServer(resources, name);
              }
              return {
                ...prev,
                mcp: {
                  ...prev.mcp,
                  clients,
                  tools,
                  commands,
                  resources
                }
              };
            });
          }
        }
        // Suppress claude.ai connectors that duplicate an enabled
        // manual server (URL-signature match). Plugin dedup above only
        // handles `plugin:*` keys; this catches manual `.mcp.json` entries.
        // plugin:* must be excluded here — step 1 already suppressed
        // those (claude.ai wins); leaving them in suppresses the
        // connector too, and neither survives (gh-39974).
        const nonPluginConfigs = pickBy(regularMcpConfigs, (_, n) => !n.startsWith('plugin:'));
        const {
          servers: dedupedClaudeAi
        } = dedupClaudeAiMcpServers(claudeaiConfigs, nonPluginConfigs);
        return connectMcpBatch(dedupedClaudeAi, 'claudeai');
      });
      let claudeaiTimer: ReturnType<typeof setTimeout> | undefined;
      const claudeaiTimedOut = await Promise.race([claudeaiConnect.then(() => false), new Promise<boolean>(resolve => {
        claudeaiTimer = setTimeout(r => r(true), CLAUDE_AI_MCP_TIMEOUT_MS, resolve);
      })]);
      if (claudeaiTimer) clearTimeout(claudeaiTimer);
      if (claudeaiTimedOut) {
        logForDebugging(`[MCP] claude.ai connectors not ready after ${CLAUDE_AI_MCP_TIMEOUT_MS}ms — proceeding; background connection continues`);
      }
      profileCheckpoint('after_connectMcp_claudeai');

      // In headless mode, start deferred prefetches immediately (no user typing delay)
      // --bare / SIMPLE: startDeferredPrefetches early-returns internally.
      // backgroundHousekeeping (initExtractMemories, pruneShellSnapshots,
      // cleanupOldMessageFiles) and sdkHeapDumpMonitor are all bookkeeping
      // that scripted calls don't need — the next interactive session reconciles.
      if (!isBareMode()) {
        startDeferredPrefetches();
        void import('./utils/backgroundHousekeeping.js').then(m => m.startBackgroundHousekeeping());
        if ("external" === 'ant') {
          void import('./utils/sdkHeapDumpMonitor.js').then(m => m.startSdkMemoryMonitor());
        }
      }
      logSessionTelemetry();
      profileCheckpoint('before_print_import');
      const {
        runHeadless
      } = await import('src/cli/print.js');
      profileCheckpoint('after_print_import');
      void runHeadless(inputPrompt, () => headlessStore.getState(), headlessStore.setState, commandsHeadless, tools, sdkMcpConfigs, agentDefinitions.activeAgents, {
        continue: options.continue,
        resume: options.resume,
        verbose: verbose,
        outputFormat: outputFormat,
        jsonSchema,
        permissionPromptToolName: options.permissionPromptTool,
        allowedTools,
        thinkingConfig,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        taskBudget: options.taskBudget ? {
          total: options.taskBudget
        } : undefined,
        systemPrompt,
        appendSystemPrompt,
        userSpecifiedModel: effectiveModel,
        fallbackModel: userSpecifiedFallbackModel,
        teleport,
        sdkUrl,
        replayUserMessages: effectiveReplayUserMessages,
        includePartialMessages: effectiveIncludePartialMessages,
        forkSession: options.forkSession || false,
        resumeSessionAt: options.resumeSessionAt || undefined,
        rewindFiles: options.rewindFiles,
        enableAuthStatus: options.enableAuthStatus,
        agent: agentCli,
        workload: options.workload,
        setupTrigger: setupTrigger ?? undefined,
        sessionStartHooksPromise
      });
      return;
    }

    // Log model config at startup
    logEvent('tengu_startup_manual_model_config', {
      cli_flag: options.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      env_var: process.env.ANTHROPIC_MODEL as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      settings_file: (getInitialSettings() || {}).model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      subscriptionType: getSubscriptionType() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      agent: agentSetting as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });

    // Get deprecation warning for the initial model (resolvedInitialModel computed earlier for hooks parallelization)
    const deprecationWarning = getModelDeprecationWarning(resolvedInitialModel);

    // Build initial notification queue
    const initialNotifications: Array<{
      key: string;
      text: string;
      color?: 'warning';
      priority: 'high';
    }> = [];
    if (permissionModeNotification) {
      initialNotifications.push({
        key: 'permission-mode-notification',
        text: permissionModeNotification,
        priority: 'high'
      });
    }
    if (deprecationWarning) {
      initialNotifications.push({
        key: 'model-deprecation-warning',
        text: deprecationWarning,
        color: 'warning',
        priority: 'high'
      });
    }
    if (overlyBroadBashPermissions.length > 0) {
      const displayList = uniq(overlyBroadBashPermissions.map(p => p.ruleDisplay));
      const displays = displayList.join(', ');
      const sources = uniq(overlyBroadBashPermissions.map(p => p.sourceDisplay)).join(', ');
      const n = displayList.length;
      initialNotifications.push({
        key: 'overly-broad-bash-notification',
        text: `${displays} allow ${plural(n, 'rule')} from ${sources} ${plural(n, 'was', 'were')} ignored \u2014 not available for Ants, please use auto-mode instead`,
        color: 'warning',
        priority: 'high'
      });
    }
    const effectiveToolPermissionContext = {
      ...toolPermissionContext,
      mode: isAgentSwarmsEnabled() && getTeammateUtils().isPlanModeRequired() ? 'plan' as const : toolPermissionContext.mode
    };
    // All startup opt-in paths (--tools, --brief, defaultView) have fired
    // above; initialIsBriefOnly just reads the resulting state.
    const initialIsBriefOnly = feature('KAIROS') || feature('KAIROS_BRIEF') ? getUserMsgOptIn() : false;
    const fullRemoteControl = remoteControl || getRemoteControlAtStartup() || kairosEnabled;
    let ccrMirrorEnabled = false;
    if (feature('CCR_MIRROR') && !fullRemoteControl) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const {
        isCcrMirrorEnabled
      } = require('./bridge/bridgeEnabled.js') as typeof import('./bridge/bridgeEnabled.js');
      /* eslint-enable @typescript-eslint/no-require-imports */
      ccrMirrorEnabled = isCcrMirrorEnabled();
    }
    const initialState: AppState = {
      settings: getInitialSettings(),
      tasks: {},
      agentNameRegistry: new Map(),
      verbose: verbose ?? getGlobalConfig().verbose ?? false,
      mainLoopModel: initialMainLoopModel,
      mainLoopModelForSession: null,
      isBriefOnly: initialIsBriefOnly,
      expandedView: getGlobalConfig().showSpinnerTree ? 'teammates' : getGlobalConfig().showExpandedTodos ? 'tasks' : 'none',
      showTeammateMessagePreview: isAgentSwarmsEnabled() ? false : undefined,
      selectedIPAgentIndex: -1,
      coordinatorTaskIndex: -1,
      viewSelectionMode: 'none',
      footerSelection: null,
      toolPermissionContext: effectiveToolPermissionContext,
      agent: mainThreadAgentDefinition?.agentType,
      agentDefinitions,
      mcp: {
        clients: [],
        tools: [],
        commands: [],
        resources: {},
        pluginReconnectKey: 0
      },
      plugins: {
        enabled: [],
        disabled: [],
        commands: [],
        errors: [],
        installationStatus: {
          marketplaces: [],
          plugins: []
        },
        needsRefresh: false
      },
      statusLineText: undefined,
      kairosEnabled,
      remoteSessionUrl: undefined,
      remoteConnectionStatus: 'connecting',
      remoteBackgroundTaskCount: 0,
      replBridgeEnabled: fullRemoteControl || ccrMirrorEnabled,
      replBridgeExplicit: remoteControl,
      replBridgeOutboundOnly: ccrMirrorEnabled,
      replBridgeConnected: false,
      replBridgeSessionActive: false,
      replBridgeReconnecting: false,
      replBridgeConnectUrl: undefined,
      replBridgeSessionUrl: undefined,
      replBridgeEnvironmentId: undefined,
      replBridgeSessionId: undefined,
      replBridgeError: undefined,
      replBridgeInitialName: remoteControlName,
      showRemoteCallout: false,
      notifications: {
        current: null,
        queue: initialNotifications
      },
      elicitation: {
        queue: []
      },
      todos: {},
      remoteAgentTaskSuggestions: [],
      fileHistory: {
        snapshots: [],
        trackedFiles: new Set(),
        snapshotSequence: 0
      },
      attribution: createEmptyAttributionState(),
      thinkingEnabled,
      promptSuggestionEnabled: shouldEnablePromptSuggestion(),
      sessionHooks: new Map(),
      inbox: {
        messages: []
      },
      promptSuggestion: {
        text: null,
        promptId: null,
        shownAt: 0,
        acceptedAt: 0,
        generationRequestId: null
      },
      speculation: IDLE_SPECULATION_STATE,
      speculationSessionTimeSavedMs: 0,
      skillImprovement: {
        suggestion: null
      },
      workerSandboxPermissions: {
        queue: [],
        selectedIndex: 0
      },
      pendingWorkerRequest: null,
      pendingSandboxRequest: null,
      authVersion: 0,
      initialMessage: inputPrompt ? {
        message: createUserMessage({
          content: String(inputPrompt)
        })
      } : null,
      effortValue: parseEffortValue(options.effort) ?? getInitialEffortSetting(),
      activeOverlays: new Set<string>(),
      fastMode: getInitialFastModeSetting(resolvedInitialModel),
      ...(isAdvisorEnabled() && advisorModel && {
        advisorModel
      }),
      // Compute teamContext synchronously to avoid useEffect setState during render.
      // KAIROS: assistantTeamContext takes precedence — set earlier in the
      // KAIROS block so Agent(name: "foo") can spawn in-process teammates
      // without TeamCreate. computeInitialTeamContext() is for tmux-spawned
      // teammates reading their own identity, not the assistant-mode leader.
      teamContext: feature('KAIROS') ? assistantTeamContext ?? computeInitialTeamContext?.() : computeInitialTeamContext?.()
    };

    // Add CLI initial prompt to history
    if (inputPrompt) {
      addToHistory(String(inputPrompt));
    }
    const initialTools = mcpTools;

    // Increment numStartups synchronously — first-render readers like
    // shouldShowEffortCallout (via useState initializer) need the updated
    // value before setImmediate fires. Defer only telemetry.
    saveGlobalConfig(current => ({
      ...current,
      numStartups: (current.numStartups ?? 0) + 1
    }));
    setImmediate(() => {
      void logStartupTelemetry();
      logSessionTelemetry();
    });

    // Set up per-turn session environment data uploader (ant-only build).
    // Default-enabled for all ant users when working in an Anthropic-owned
    // repo. Captures git/filesystem state (NOT transcripts) at each turn so
    // environments can be recreated at any user message index. Gating:
    //   - Build-time: this import is stubbed in external builds.
    //   - Runtime: uploader checks github.com/anthropics/* remote + gcloud auth.
    //   - Safety: CLAUDE_CODE_DISABLE_SESSION_DATA_UPLOAD=1 bypasses (tests set this).
    // Import is dynamic + async to avoid adding startup latency.
    const sessionUploaderPromise = "external" === 'ant' ? import('./utils/sessionDataUploader.js') : null;

    // Defer session uploader resolution to the onTurnComplete callback to avoid
    // adding a new top-level await in main.tsx (performance-critical path).
    // The per-turn auth logic in sessionDataUploader.ts handles unauthenticated
    // state gracefully (re-checks each turn, so auth recovery mid-session works).
    const uploaderReady = sessionUploaderPromise ? sessionUploaderPromise.then(mod => mod.createSessionTurnUploader()).catch(() => null) : null;
    const sessionConfig = {
      debug: debug || debugToStderr,
      commands: [...commands, ...mcpCommands],
      initialTools,
      mcpClients,
      autoConnectIdeFlag: ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      dynamicMcpConfig,
      strictMcpConfig,
      systemPrompt,
      appendSystemPrompt,
      taskListId,
      thinkingConfig,
      ...(uploaderReady && {
        onTurnComplete: (messages: MessageType[]) => {
          void uploaderReady.then(uploader => uploader?.(messages));
        }
      })
    };

    // Shared context for processResumedConversation calls
    const resumeContext = {
      modeApi: coordinatorModeModule,
      mainThreadAgentDefinition,
      agentDefinitions,
      currentCwd,
      cliAgents,
      initialState
    };
    if (options.continue) {
      // Continue the most recent conversation directly
      let resumeSucceeded = false;
      try {
        const resumeStart = performance.now();

        // Clear stale caches before resuming to ensure fresh file/skill discovery
        const {
          clearSessionCaches
        } = await import('./commands/clear/caches.js');
        clearSessionCaches();
        const result = await loadConversationForResume(undefined /* sessionId */, undefined /* sourceFile */);
        if (!result) {
          logEvent('tengu_continue', {
            success: false
          });
          return await exitWithError(root, 'No conversation found to continue');
        }
        const loaded = await processResumedConversation(result, {
          forkSession: !!options.forkSession,
          includeAttribution: true,
          transcriptPath: result.fullPath
        }, resumeContext);
        if (loaded.restoredAgentDef) {
          mainThreadAgentDefinition = loaded.restoredAgentDef;
        }
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        logEvent('tengu_continue', {
          success: true,
          resume_duration_ms: Math.round(performance.now() - resumeStart)
        });
        resumeSucceeded = true;
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: loaded.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: loaded.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: loaded.messages,
          initialFileHistorySnapshots: loaded.fileHistorySnapshots,
          initialContentReplacements: loaded.contentReplacements,
          initialAgentName: loaded.agentName,
          initialAgentColor: loaded.agentColor
        }, renderAndRun);
      } catch (error) {
        if (!resumeSucceeded) {
          logEvent('tengu_continue', {
            success: false
          });
        }
        logError(error);
        process.exit(1);
      }
    } else if (feature('DIRECT_CONNECT') && _pendingConnect?.url) {
      // `claude connect <url>` — full interactive TUI connected to a remote server
      let directConnectConfig;
      try {
        const session = await createDirectConnectSession({
          serverUrl: _pendingConnect.url,
          authToken: _pendingConnect.authToken,
          cwd: getOriginalCwd(),
          dangerouslySkipPermissions: _pendingConnect.dangerouslySkipPermissions
        });
        if (session.workDir) {
          setOriginalCwd(session.workDir);
          setCwdState(session.workDir);
        }
        setDirectConnectServerUrl(_pendingConnect.url);
        directConnectConfig = session.config;
      } catch (err) {
        return await exitWithError(root, err instanceof DirectConnectError ? err.message : String(err), () => gracefulShutdown(1));
      }
      const connectInfoMessage = createSystemMessage(`Connected to server at ${_pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`, 'info');
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [connectInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        directConnectConfig,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (feature('SSH_REMOTE') && _pendingSSH?.host) {
      // `claude ssh <host> [dir]` — probe remote, deploy binary if needed,
      // spawn ssh with unix-socket -R forward to a local auth proxy, hand
      // the REPL an SSHSession. Tools run remotely, UI renders locally.
      // `--local` skips probe/deploy/ssh and spawns the current binary
      // directly with the same env — e2e test of the proxy/auth plumbing.
      const {
        createSSHSession,
        createLocalSSHSession,
        SSHSessionError
      } = await import('./ssh/createSSHSession.js');
      let sshSession;
      try {
        if (_pendingSSH.local) {
          process.stderr.write('Starting local ssh-proxy test session...\n');
          sshSession = createLocalSSHSession({
            cwd: _pendingSSH.cwd,
            permissionMode: _pendingSSH.permissionMode,
            dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions
          });
        } else {
          process.stderr.write(`Connecting to ${_pendingSSH.host}…\n`);
          // In-place progress: \r + EL0 (erase to end of line). Final \n on
          // success so the next message lands on a fresh line. No-op when
          // stderr isn't a TTY (piped/redirected) — \r would just emit noise.
          const isTTY = process.stderr.isTTY;
          let hadProgress = false;
          sshSession = await createSSHSession({
            host: _pendingSSH.host,
            cwd: _pendingSSH.cwd,
            localVersion: MACRO.VERSION,
            permissionMode: _pendingSSH.permissionMode,
            dangerouslySkipPermissions: _pendingSSH.dangerouslySkipPermissions,
            extraCliArgs: _pendingSSH.extraCliArgs
          }, isTTY ? {
            onProgress: msg => {
              hadProgress = true;
              process.stderr.write(`\r  ${msg}\x1b[K`);
            }
          } : {});
          if (hadProgress) process.stderr.write('\n');
        }
        setOriginalCwd(sshSession.remoteCwd);
        setCwdState(sshSession.remoteCwd);
        setDirectConnectServerUrl(_pendingSSH.local ? 'local' : _pendingSSH.host);
      } catch (err) {
        return await exitWithError(root, err instanceof SSHSessionError ? err.message : String(err), () => gracefulShutdown(1));
      }
      const sshInfoMessage = createSystemMessage(_pendingSSH.local ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy` : `SSH session to ${_pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`, 'info');
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        debug: debug || debugToStderr,
        commands,
        initialTools: [],
        initialMessages: [sshInfoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        sshSession,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (feature('KAIROS') && _pendingAssistantChat && (_pendingAssistantChat.sessionId || _pendingAssistantChat.discover)) {
      // `claude assistant [sessionId]` — REPL as a pure viewer client
      // of a remote assistant session. The agentic loop runs remotely; this
      // process streams live events and POSTs messages. History is lazy-
      // loaded by useAssistantHistory on scroll-up (no blocking fetch here).
      const {
        discoverAssistantSessions
      } = await import('./assistant/sessionDiscovery.js');
      let targetSessionId = _pendingAssistantChat.sessionId;

      // Discovery flow — list bridge environments, filter sessions
      if (!targetSessionId) {
        let sessions;
        try {
          sessions = await discoverAssistantSessions();
        } catch (e) {
          return await exitWithError(root, `Failed to discover sessions: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
        }
        if (sessions.length === 0) {
          let installedDir: string | null;
          try {
            installedDir = await launchAssistantInstallWizard(root);
          } catch (e) {
            return await exitWithError(root, `Assistant installation failed: ${e instanceof Error ? e.message : e}`, () => gracefulShutdown(1));
          }
          if (installedDir === null) {
            await gracefulShutdown(0);
            process.exit(0);
          }
          // The daemon needs a few seconds to spin up its worker and
          // establish a bridge session before discovery will find it.
          return await exitWithMessage(root, `Assistant installed in ${installedDir}. The daemon is starting up — run \`claude assistant\` again in a few seconds to connect.`, {
            exitCode: 0,
            beforeExit: () => gracefulShutdown(0)
          });
        }
        if (sessions.length === 1) {
          targetSessionId = sessions[0]!.id;
        } else {
          const picked = await launchAssistantSessionChooser(root, {
            sessions
          });
          if (!picked) {
            await gracefulShutdown(0);
            process.exit(0);
          }
          targetSessionId = picked;
        }
      }

      // Auth — call prepareApiRequest() once for orgUUID, but use a
      // getAccessToken closure for the token so reconnects get fresh tokens.
      const {
        checkAndRefreshOAuthTokenIfNeeded,
        getClaudeAIOAuthTokens
      } = await import('./utils/auth.js');
      await checkAndRefreshOAuthTokenIfNeeded();
      let apiCreds;
      try {
        apiCreds = await prepareApiRequest();
      } catch (e) {
        return await exitWithError(root, `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`, () => gracefulShutdown(1));
      }
      const getAccessToken = (): string => getClaudeAIOAuthTokens()?.accessToken ?? apiCreds.accessToken;

      // Brief mode activation: setKairosActive(true) satisfies BOTH opt-in
      // and entitlement for isBriefEnabled() (BriefTool.ts:124-132).
      setKairosActive(true);
      setUserMsgOptIn(true);
      setIsRemoteMode(true);
      const remoteSessionConfig = createRemoteSessionConfig(targetSessionId, getAccessToken, apiCreds.orgUUID, /* hasInitialPrompt */false, /* viewerOnly */true);
      const infoMessage = createSystemMessage(`Attached to assistant session ${targetSessionId.slice(0, 8)}…`, 'info');
      const assistantInitialState: AppState = {
        ...initialState,
        isBriefOnly: true,
        kairosEnabled: false,
        replBridgeEnabled: false
      };
      const remoteCommands = filterCommandsForRemoteMode(commands);
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState: assistantInitialState
      }, {
        debug: debug || debugToStderr,
        commands: remoteCommands,
        initialTools: [],
        initialMessages: [infoMessage],
        mcpClients: [],
        autoConnectIdeFlag: ide,
        mainThreadAgentDefinition,
        disableSlashCommands,
        remoteSessionConfig,
        thinkingConfig
      }, renderAndRun);
      return;
    } else if (options.resume || options.fromPr || teleport || remote !== null) {
      // Handle resume flow - from file (ant-only), session ID, or interactive selector

      // Clear stale caches before resuming to ensure fresh file/skill discovery
      const {
        clearSessionCaches
      } = await import('./commands/clear/caches.js');
      clearSessionCaches();
      let messages: MessageType[] | null = null;
      let processedResume: ProcessedResume | undefined = undefined;
      let maybeSessionId = validateUuid(options.resume);
      let searchTerm: string | undefined = undefined;
      // Store full LogOption when found by custom title (for cross-worktree resume)
      let matchedLog: LogOption | null = null;
      // PR filter for --from-pr flag
      let filterByPr: boolean | number | string | undefined = undefined;

      // Handle --from-pr flag
      if (options.fromPr) {
        if (options.fromPr === true) {
          // Show all sessions with linked PRs
          filterByPr = true;
        } else if (typeof options.fromPr === 'string') {
          // Could be a PR number or URL
          filterByPr = options.fromPr;
        }
      }

      // If resume value is not a UUID, try exact match by custom title first
      if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
        const trimmedValue = options.resume.trim();
        if (trimmedValue) {
          const matches = await searchSessionsByCustomTitle(trimmedValue, {
            exact: true
          });
          if (matches.length === 1) {
            // Exact match found - store full LogOption for cross-worktree resume
            matchedLog = matches[0]!;
            maybeSessionId = getSessionIdFromLog(matchedLog) ?? null;
          } else {
            // No match or multiple matches - use as search term for picker
            searchTerm = trimmedValue;
          }
        }
      }

      // --remote and --teleport both create/resume Claude Code Web (CCR) sessions.
      // Remote Control (--rc) is a separate feature gated in initReplBridge.ts.
      if (remote !== null || teleport) {
        await waitForPolicyLimitsToLoad();
        if (!isPolicyAllowed('allow_remote_sessions')) {
          return await exitWithError(root, "Error: Remote sessions are disabled by your organization's policy.", () => gracefulShutdown(1));
        }
      }
      if (remote !== null) {
        // Create remote session (optionally with initial prompt)
        const hasInitialPrompt = remote.length > 0;

        // Check if TUI mode is enabled - description is only optional in TUI mode
        const isRemoteTuiEnabled = getFeatureValue_CACHED_MAY_BE_STALE('tengu_remote_backend', false);
        if (!isRemoteTuiEnabled && !hasInitialPrompt) {
          return await exitWithError(root, 'Error: --remote requires a description.\nUsage: claude --remote "your task description"', () => gracefulShutdown(1));
        }
        logEvent('tengu_remote_create_session', {
          has_initial_prompt: String(hasInitialPrompt) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });

        // Pass current branch so CCR clones the repo at the right revision
        const currentBranch = await getBranch();
        const createdSession = await teleportToRemoteWithErrorHandling(root, hasInitialPrompt ? remote : null, new AbortController().signal, currentBranch || undefined);
        if (!createdSession) {
          logEvent('tengu_remote_create_session_error', {
            error: 'unable_to_create_session' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          return await exitWithError(root, 'Error: Unable to create remote session', () => gracefulShutdown(1));
        }
        logEvent('tengu_remote_create_session_success', {
          session_id: createdSession.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        });

        // Check if new remote TUI mode is enabled via feature gate
        if (!isRemoteTuiEnabled) {
          // Original behavior: print session info and exit
          process.stdout.write(`Created remote session: ${createdSession.title}\n`);
          process.stdout.write(`View: ${getRemoteSessionUrl(createdSession.id)}?m=0\n`);
          process.stdout.write(`Resume with: claude --teleport ${createdSession.id}\n`);
          await gracefulShutdown(0);
          process.exit(0);
        }

        // New behavior: start local TUI with CCR engine
        // Mark that we're in remote mode for command visibility
        setIsRemoteMode(true);
        switchSession(asSessionId(createdSession.id));

        // Get OAuth credentials for remote session
        let apiCreds: {
          accessToken: string;
          orgUUID: string;
        };
        try {
          apiCreds = await prepareApiRequest();
        } catch (error) {
          logError(toError(error));
          return await exitWithError(root, `Error: ${errorMessage(error) || 'Failed to authenticate'}`, () => gracefulShutdown(1));
        }

        // Create remote session config for the REPL
        const {
          getClaudeAIOAuthTokens: getTokensForRemote
        } = await import('./utils/auth.js');
        const getAccessTokenForRemote = (): string => getTokensForRemote()?.accessToken ?? apiCreds.accessToken;
        const remoteSessionConfig = createRemoteSessionConfig(createdSession.id, getAccessTokenForRemote, apiCreds.orgUUID, hasInitialPrompt);

        // Add remote session info as initial system message
        const remoteSessionUrl = `${getRemoteSessionUrl(createdSession.id)}?m=0`;
        const remoteInfoMessage = createSystemMessage(`/remote-control is active. Code in CLI or at ${remoteSessionUrl}`, 'info');

        // Create initial user message from the prompt if provided (CCR echoes it back but we ignore that)
        const initialUserMessage = hasInitialPrompt ? createUserMessage({
          content: remote
        }) : null;

        // Set remote session URL in app state for footer indicator
        const remoteInitialState = {
          ...initialState,
          remoteSessionUrl
        };

        // Pre-filter commands to only include remote-safe ones.
        // CCR's init response may further refine the list (via handleRemoteInit in REPL).
        const remoteCommands = filterCommandsForRemoteMode(commands);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: remoteInitialState
        }, {
          debug: debug || debugToStderr,
          commands: remoteCommands,
          initialTools: [],
          initialMessages: initialUserMessage ? [remoteInfoMessage, initialUserMessage] : [remoteInfoMessage],
          mcpClients: [],
          autoConnectIdeFlag: ide,
          mainThreadAgentDefinition,
          disableSlashCommands,
          remoteSessionConfig,
          thinkingConfig
        }, renderAndRun);
        return;
      } else if (teleport) {
        if (teleport === true || teleport === '') {
          // Interactive mode: show task selector and handle resume
          logEvent('tengu_teleport_interactive_mode', {});
          logForDebugging('selectAndResumeTeleportTask: Starting teleport flow...');
          const teleportResult = await launchTeleportResumeWrapper(root);
          if (!teleportResult) {
            // User cancelled or error occurred
            await gracefulShutdown(0);
            process.exit(0);
          }
          const {
            branchError
          } = await checkOutTeleportedSessionBranch(teleportResult.branch);
          messages = processMessagesForTeleportResume(teleportResult.log, branchError);
        } else if (typeof teleport === 'string') {
          logEvent('tengu_teleport_resume_session', {
            mode: 'direct' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          try {
            // First, fetch session and validate repository before checking git state
            const sessionData = await fetchSession(teleport);
            const repoValidation = await validateSessionRepository(sessionData);

            // Handle repo mismatch or not in repo cases
            if (repoValidation.status === 'mismatch' || repoValidation.status === 'not_in_repo') {
              const sessionRepo = repoValidation.sessionRepo;
              if (sessionRepo) {
                // Check for known paths
                const knownPaths = getKnownPathsForRepo(sessionRepo);
                const existingPaths = await filterExistingPaths(knownPaths);
                if (existingPaths.length > 0) {
                  // Show directory switch dialog
                  const selectedPath = await launchTeleportRepoMismatchDialog(root, {
                    targetRepo: sessionRepo,
                    initialPaths: existingPaths
                  });
                  if (selectedPath) {
                    // Change to the selected directory
                    process.chdir(selectedPath);
                    setCwd(selectedPath);
                    setOriginalCwd(selectedPath);
                  } else {
                    // User cancelled
                    await gracefulShutdown(0);
                  }
                } else {
                  // No known paths - show original error
                  throw new TeleportOperationError(`You must run claude --teleport ${teleport} from a checkout of ${sessionRepo}.`, chalk.red(`You must run claude --teleport ${teleport} from a checkout of ${chalk.bold(sessionRepo)}.\n`));
                }
              }
            } else if (repoValidation.status === 'error') {
              throw new TeleportOperationError(repoValidation.errorMessage || 'Failed to validate session', chalk.red(`Error: ${repoValidation.errorMessage || 'Failed to validate session'}\n`));
            }
            await validateGitState();

            // Use progress UI for teleport
            const {
              teleportWithProgress
            } = await import('./components/TeleportProgress.js');
            const result = await teleportWithProgress(root, teleport);
            // Track teleported session for reliability logging
            setTeleportedSessionInfo({
              sessionId: teleport
            });
            messages = result.messages;
          } catch (error) {
            if (error instanceof TeleportOperationError) {
              process.stderr.write(error.formattedMessage + '\n');
            } else {
              logError(error);
              process.stderr.write(chalk.red(`Error: ${errorMessage(error)}\n`));
            }
            await gracefulShutdown(1);
          }
        }
      }
      if ("external" === 'ant') {
        if (options.resume && typeof options.resume === 'string' && !maybeSessionId) {
          // Check for ccshare URL (e.g. https://go/ccshare/boris-20260311-211036)
          const {
            parseCcshareId,
            loadCcshare
          } = await import('./utils/ccshareResume.js');
          const ccshareId = parseCcshareId(options.resume);
          if (ccshareId) {
            try {
              const resumeStart = performance.now();
              const logOption = await loadCcshare(ccshareId);
              const result = await loadConversationForResume(logOption, undefined);
              if (result) {
                processedResume = await processResumedConversation(result, {
                  forkSession: true,
                  transcriptPath: result.fullPath
                }, resumeContext);
                if (processedResume.restoredAgentDef) {
                  mainThreadAgentDefinition = processedResume.restoredAgentDef;
                }
                logEvent('tengu_session_resumed', {
                  entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: true,
                  resume_duration_ms: Math.round(performance.now() - resumeStart)
                });
              } else {
                logEvent('tengu_session_resumed', {
                  entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                  success: false
                });
              }
            } catch (error) {
              logEvent('tengu_session_resumed', {
                entrypoint: 'ccshare' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false
              });
              logError(error);
              await exitWithError(root, `Unable to resume from ccshare: ${errorMessage(error)}`, () => gracefulShutdown(1));
            }
          } else {
            const resolvedPath = resolve(options.resume);
            try {
              const resumeStart = performance.now();
              let logOption;
              try {
                // Attempt to load as a transcript file; ENOENT falls through to session-ID handling
                logOption = await loadTranscriptFromFile(resolvedPath);
              } catch (error) {
                if (!isENOENT(error)) throw error;
                // ENOENT: not a file path — fall through to session-ID handling
              }
              if (logOption) {
                const result = await loadConversationForResume(logOption, undefined /* sourceFile */);
                if (result) {
                  processedResume = await processResumedConversation(result, {
                    forkSession: !!options.forkSession,
                    transcriptPath: result.fullPath
                  }, resumeContext);
                  if (processedResume.restoredAgentDef) {
                    mainThreadAgentDefinition = processedResume.restoredAgentDef;
                  }
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: true,
                    resume_duration_ms: Math.round(performance.now() - resumeStart)
                  });
                } else {
                  logEvent('tengu_session_resumed', {
                    entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    success: false
                  });
                }
              }
            } catch (error) {
              logEvent('tengu_session_resumed', {
                entrypoint: 'file' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                success: false
              });
              logError(error);
              await exitWithError(root, `Unable to load transcript from file: ${options.resume}`, () => gracefulShutdown(1));
            }
          }
        }
      }

      // If not loaded as a file, try as session ID
      if (maybeSessionId) {
        // Resume specific session by ID
        const sessionId = maybeSessionId;
        try {
          const resumeStart = performance.now();
          // Use matchedLog if available (for cross-worktree resume by custom title)
          // Otherwise fall back to sessionId string (for direct UUID resume)
          const result = await loadConversationForResume(matchedLog ?? sessionId, undefined);
          if (!result) {
            logEvent('tengu_session_resumed', {
              entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              success: false
            });
            return await exitWithError(root, `No conversation found with session ID: ${sessionId}`);
          }
          const fullPath = matchedLog?.fullPath ?? result.fullPath;
          processedResume = await processResumedConversation(result, {
            forkSession: !!options.forkSession,
            sessionIdOverride: sessionId,
            transcriptPath: fullPath
          }, resumeContext);
          if (processedResume.restoredAgentDef) {
            mainThreadAgentDefinition = processedResume.restoredAgentDef;
          }
          logEvent('tengu_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: true,
            resume_duration_ms: Math.round(performance.now() - resumeStart)
          });
        } catch (error) {
          logEvent('tengu_session_resumed', {
            entrypoint: 'cli_flag' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            success: false
          });
          logError(error);
          await exitWithError(root, `Failed to resume session ${sessionId}`);
        }
      }

      // Await file downloads before rendering REPL (files must be available)
      if (fileDownloadPromise) {
        try {
          const results = await fileDownloadPromise;
          const failedCount = count(results, r => !r.success);
          if (failedCount > 0) {
            process.stderr.write(chalk.yellow(`Warning: ${failedCount}/${results.length} file(s) failed to download.\n`));
          }
        } catch (error) {
          return await exitWithError(root, `Error downloading files: ${errorMessage(error)}`);
        }
      }

      // If we have a processed resume or teleport messages, render the REPL
      const resumeData = processedResume ?? (Array.isArray(messages) ? {
        messages,
        fileHistorySnapshots: undefined,
        agentName: undefined,
        agentColor: undefined as AgentColorName | undefined,
        restoredAgentDef: mainThreadAgentDefinition,
        initialState,
        contentReplacements: undefined
      } : undefined);
      if (resumeData) {
        maybeActivateProactive(options);
        maybeActivateBrief(options);
        await launchRepl(root, {
          getFpsMetrics,
          stats,
          initialState: resumeData.initialState
        }, {
          ...sessionConfig,
          mainThreadAgentDefinition: resumeData.restoredAgentDef ?? mainThreadAgentDefinition,
          initialMessages: resumeData.messages,
          initialFileHistorySnapshots: resumeData.fileHistorySnapshots,
          initialContentReplacements: resumeData.contentReplacements,
          initialAgentName: resumeData.agentName,
          initialAgentColor: resumeData.agentColor
        }, renderAndRun);
      } else {
        // Show interactive selector (includes same-repo worktrees)
        // Note: ResumeConversation loads logs internally to ensure proper GC after selection
        await launchResumeChooser(root, {
          getFpsMetrics,
          stats,
          initialState
        }, getWorktreePaths(getOriginalCwd()), {
          ...sessionConfig,
          initialSearchQuery: searchTerm,
          forkSession: options.forkSession,
          filterByPr
        });
      }
    } else {
      // Pass unresolved hooks promise to REPL so it can render immediately
      // instead of blocking ~500ms waiting for SessionStart hooks to finish.
      // REPL will inject hook messages when they resolve and await them before
      // the first API call so the model always sees hook context.
      const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined;
      profileCheckpoint('action_after_hooks');
      maybeActivateProactive(options);
      maybeActivateBrief(options);
      // Persist the current mode for fresh sessions so future resumes know what mode was used
      if (feature('COORDINATOR_MODE')) {
        saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal');
      }

      // If launched via a deep link, show a provenance banner so the user
      // knows the session originated externally. Linux xdg-open and
      // browsers with "always allow" set dispatch the link with no OS-level
      // confirmation, so this is the only signal the user gets that the
      // prompt — and the working directory / CLAUDE.md it implies — came
      // from an external source rather than something they typed.
      let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null;
      if (feature('LODESTONE')) {
        if (options.deepLinkOrigin) {
          logEvent('tengu_deep_link_opened', {
            has_prefill: Boolean(options.prefill),
            has_repo: Boolean(options.deepLinkRepo)
          });
          deepLinkBanner = createSystemMessage(buildDeepLinkBanner({
            cwd: getCwd(),
            prefillLength: options.prefill?.length,
            repo: options.deepLinkRepo,
            lastFetch: options.deepLinkLastFetch !== undefined ? new Date(options.deepLinkLastFetch) : undefined
          }), 'warning');
        } else if (options.prefill) {
          deepLinkBanner = createSystemMessage('Launched with a pre-filled prompt — review it before pressing Enter.', 'warning');
        }
      }
      const initialMessages = deepLinkBanner ? [deepLinkBanner, ...hookMessages] : hookMessages.length > 0 ? hookMessages : undefined;
      await launchRepl(root, {
        getFpsMetrics,
        stats,
        initialState
      }, {
        ...sessionConfig,
        initialMessages,
        pendingHookMessages
      }, renderAndRun);
    }
  }).version(`${MACRO.VERSION} (Claude Code)`, '-v, --version', 'Output the version number');

  // Worktree flags
  program.option('-w, --worktree [name]', 'Create a new git worktree for this session (optionally specify a name)');
  program.option('--tmux', 'Create a tmux session for the worktree (requires --worktree). Uses iTerm2 native panes when available; use --tmux=classic for traditional tmux.');
  if (canUserConfigureAdvisor()) {
    program.addOption(new Option('--advisor <model>', 'Enable the server-side advisor tool with the specified model (alias or full ID).').hideHelp());
  }
  if ("external" === 'ant') {
    program.addOption(new Option('--delegate-permissions', '[ANT-ONLY] Alias for --permission-mode auto.').implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--dangerously-skip-permissions-with-classifiers', '[ANT-ONLY] Deprecated alias for --permission-mode auto.').hideHelp().implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--afk', '[ANT-ONLY] Deprecated alias for --permission-mode auto.').hideHelp().implies({
      permissionMode: 'auto'
    }));
    program.addOption(new Option('--tasks [id]', '[ANT-ONLY] Tasks mode: watch for tasks and auto-process them. Optional id is used as both the task list ID and agent ID (defaults to "tasklist").').argParser(String).hideHelp());
    program.option('--agent-teams', '[ANT-ONLY] Force Claude to use multi-agent mode for solving problems', () => true);
  }
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    program.addOption(new Option('--enable-auto-mode', 'Opt in to auto mode').hideHelp());
  }
  if (feature('PROACTIVE') || feature('KAIROS')) {
    program.addOption(new Option('--proactive', 'Start in proactive autonomous mode'));
  }
  if (feature('UDS_INBOX')) {
    program.addOption(new Option('--messaging-socket-path <path>', 'Unix domain socket path for the UDS messaging server (defaults to a tmp path)'));
  }
  if (feature('KAIROS') || feature('KAIROS_BRIEF')) {
    program.addOption(new Option('--brief', 'Enable SendUserMessage tool for agent-to-user communication'));
  }
  if (feature('KAIROS')) {
    program.addOption(new Option('--assistant', 'Force assistant mode (Agent SDK daemon use)').hideHelp());
  }
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    program.addOption(new Option('--channels <servers...>', 'MCP servers whose channel notifications (inbound push) should register this session. Space-separated server names.').hideHelp());
    program.addOption(new Option('--dangerously-load-development-channels <servers...>', 'Load channel servers not on the approved allowlist. For local channel development only. Shows a confirmation dialog at startup.').hideHelp());
  }

  // Teammate identity options (set by leader when spawning tmux teammates)
  // These replace the CLAUDE_CODE_* environment variables
  program.addOption(new Option('--agent-id <id>', 'Teammate agent ID').hideHelp());
  program.addOption(new Option('--agent-name <name>', 'Teammate display name').hideHelp());
  program.addOption(new Option('--team-name <name>', 'Team name for swarm coordination').hideHelp());
  program.addOption(new Option('--agent-color <color>', 'Teammate UI color').hideHelp());
  program.addOption(new Option('--plan-mode-required', 'Require plan mode before implementation').hideHelp());
  program.addOption(new Option('--parent-session-id <id>', 'Parent session ID for analytics correlation').hideHelp());
  program.addOption(new Option('--teammate-mode <mode>', 'How to spawn teammates: "tmux", "in-process", or "auto"').choices(['auto', 'tmux', 'in-process']).hideHelp());
  program.addOption(new Option('--agent-type <type>', 'Custom agent type for this teammate').hideHelp());

  // Enable SDK URL for all builds but hide from help
  program.addOption(new Option('--sdk-url <url>', 'Use remote WebSocket endpoint for SDK I/O streaming (only with -p and stream-json format)').hideHelp());

  // Enable teleport/remote flags for all builds but keep them undocumented until GA
  program.addOption(new Option('--teleport [session]', 'Resume a teleport session, optionally specify session ID').hideHelp());
  program.addOption(new Option('--remote [description]', 'Create a remote session with the given description').hideHelp());
  if (feature('BRIDGE_MODE')) {
    program.addOption(new Option('--remote-control [name]', 'Start an interactive session with Remote Control enabled (optionally named)').argParser(value => value || true).hideHelp());
    program.addOption(new Option('--rc [name]', 'Alias for --remote-control').argParser(value => value || true).hideHelp());
  }
  if (feature('HARD_FAIL')) {
    program.addOption(new Option('--hard-fail', 'Crash on logError calls instead of silently logging').hideHelp());
  }
  profileCheckpoint('run_main_options_built');

  // -p/--print mode: skip subcommand registration. The 52 subcommands
  // (mcp, auth, plugin, skill, task, config, doctor, update, etc.) are
  // never dispatched in print mode — commander routes the prompt to the
  // default action. The subcommand registration path was measured at ~65ms
  // on baseline — mostly the isBridgeEnabled() call (25ms settings Zod parse
  // + 40ms sync keychain subprocess), both hidden by the try/catch that
  // always returns false before enableConfigs(). cc:// URLs are rewritten to
  // `open` at main() line ~851 BEFORE this runs, so argv check is safe here.
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print');
  const isCcUrl = process.argv.some(a => a.startsWith('cc://') || a.startsWith('cc+unix://'));
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse');
    await program.parseAsync(process.argv);
    profileCheckpoint('run_after_parse');
    return program;
  }

  // claude mcp

  const mcp = program.command('mcp').description('Configure and manage MCP servers').configureHelp(createSortedHelpConfig()).enablePositionalOptions();
  mcp.command('serve').description(`Start the Claude Code MCP server`).option('-d, --debug', 'Enable debug mode', () => true).option('--verbose', 'Override verbose mode setting from config', () => true).action(async ({
    debug,
    verbose
  }: {
    debug?: boolean;
    verbose?: boolean;
  }) => {
    const {
      mcpServeHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpServeHandler({
      debug,
      verbose
    });
  });

  // Register the mcp add subcommand (extracted for testability)
  registerMcpAddCommand(mcp);
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp);
  }
  mcp.command('remove <name>').description('Remove an MCP server').option('-s, --scope <scope>', 'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in').action(async (name: string, options: {
    scope?: string;
  }) => {
    const {
      mcpRemoveHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpRemoveHandler(name, options);
  });
  mcp.command('list').description('List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const {
      mcpListHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpListHandler();
  });
  mcp.command('get <name>').description('Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async (name: string) => {
    const {
      mcpGetHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpGetHandler(name);
  });
  mcp.command('add-json <name> <json>').description('Add an MCP server (stdio or SSE) with a JSON string').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)').action(async (name: string, json: string, options: {
    scope?: string;
    clientSecret?: true;
  }) => {
    const {
      mcpAddJsonHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddJsonHandler(name, json, options);
  });
  mcp.command('add-from-claude-desktop').description('Import MCP servers from Claude Desktop (Mac and WSL only)').option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local').action(async (options: {
    scope?: string;
  }) => {
    const {
      mcpAddFromDesktopHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpAddFromDesktopHandler(options);
  });
  mcp.command('reset-project-choices').description('Reset all approved and rejected project-scoped (.mcp.json) servers within this project').action(async () => {
    const {
      mcpResetChoicesHandler
    } = await import('./cli/handlers/mcp.js');
    await mcpResetChoicesHandler();
  });

  // claude server
  if (feature('DIRECT_CONNECT')) {
    program.command('server').description('Start a Claude Code session server').option('--port <number>', 'HTTP port', '0').option('--host <string>', 'Bind address', '0.0.0.0').option('--auth-token <token>', 'Bearer token for auth').option('--unix <path>', 'Listen on a unix domain socket').option('--workspace <dir>', 'Default working directory for sessions that do not specify cwd').option('--idle-timeout <ms>', 'Idle timeout for detached sessions in ms (0 = never expire)', '600000').option('--max-sessions <n>', 'Maximum concurrent sessions (0 = unlimited)', '32').action(async (opts: {
      port: string;
      host: string;
      authToken?: string;
      unix?: string;
      workspace?: string;
      idleTimeout: string;
      maxSessions: string;
    }) => {
      const {
        randomBytes
      } = await import('crypto');
      const {
        startServer
      } = await import('./server/server.js');
      const {
        SessionManager
      } = await import('./server/sessionManager.js');
      const {
        DangerousBackend
      } = await import('./server/backends/dangerousBackend.js');
      const {
        printBanner
      } = await import('./server/serverBanner.js');
      const {
        createServerLogger
      } = await import('./server/serverLog.js');
      const {
        writeServerLock,
        removeServerLock,
        probeRunningServer
      } = await import('./server/lockfile.js');
      const existing = await probeRunningServer();
      if (existing) {
        process.stderr.write(`A claude server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`);
        process.exit(1);
      }
      const authToken = opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`;
      const config = {
        port: parseInt(opts.port, 10),
        host: opts.host,
        authToken,
        unix: opts.unix,
        workspace: opts.workspace,
        idleTimeoutMs: parseInt(opts.idleTimeout, 10),
        maxSessions: parseInt(opts.maxSessions, 10)
      };
      const backend = new DangerousBackend();
      const sessionManager = new SessionManager(backend, {
        idleTimeoutMs: config.idleTimeoutMs,
        maxSessions: config.maxSessions
      });
      const logger = createServerLogger();
      const server = startServer(config, sessionManager, logger);
      const actualPort = server.port ?? config.port;
      printBanner(config, authToken, actualPort);
      await writeServerLock({
        pid: process.pid,
        port: actualPort,
        host: config.host,
        httpUrl: config.unix ? `unix:${config.unix}` : `http://${config.host}:${actualPort}`,
        startedAt: Date.now()
      });
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Stop accepting new connections before tearing down sessions.
        server.stop(true);
        await sessionManager.destroyAll();
        await removeServerLock();
        process.exit(0);
      };
      process.once('SIGINT', () => void shutdown());
      process.once('SIGTERM', () => void shutdown());
    });
  }

  // `claude ssh <host> [dir]` — registered here only so --help shows it.
  // The actual interactive flow is handled by early argv rewriting in main()
  // (parallels the DIRECT_CONNECT/cc:// pattern above). If commander reaches
  // this action it means the argv rewrite didn't fire (e.g. user ran
  // `claude ssh` with no host) — just print usage.
  if (feature('SSH_REMOTE')) {
    program.command('ssh <host> [dir]').description('Run Claude Code on a remote host over SSH. Deploys the binary and ' + 'tunnels API auth back through your local machine — no remote setup needed.').option('--permission-mode <mode>', 'Permission mode for the remote session').option('--dangerously-skip-permissions', 'Skip all permission prompts on the remote (dangerous)').option('--local', 'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' + 'Exercises the auth proxy and unix-socket plumbing without a remote host.').action(async () => {
      // Argv rewriting in main() should have consumed `ssh <host>` before
      // commander runs. Reaching here means host was missing or the
      // rewrite predicate didn't match.
      process.stderr.write('Usage: claude ssh <user@host | ssh-config-alias> [dir]\n\n' + "Runs Claude Code on a remote Linux host. You don't need to install\n" + 'anything on the remote or run `claude auth login` there — the binary is\n' + 'deployed over SSH and API auth tunnels back through your local machine.\n');
      process.exit(1);
    });
  }

  // claude connect — subcommand only handles -p (headless) mode.
  // Interactive mode (without -p) is handled by early argv rewriting in main()
  // which redirects to the main command with full TUI support.
  if (feature('DIRECT_CONNECT')) {
    program.command('open <cc-url>').description('Connect to a Claude Code server (internal — use cc:// URLs)').option('-p, --print [prompt]', 'Print mode (headless)').option('--output-format <format>', 'Output format: text, json, stream-json', 'text').action(async (ccUrl: string, opts: {
      print?: string | boolean;
      outputFormat: string;
    }) => {
      const {
        parseConnectUrl
      } = await import('./server/parseConnectUrl.js');
      const {
        serverUrl,
        authToken
      } = parseConnectUrl(ccUrl);
      let connectConfig;
      try {
        const session = await createDirectConnectSession({
          serverUrl,
          authToken,
          cwd: getOriginalCwd(),
          dangerouslySkipPermissions: _pendingConnect?.dangerouslySkipPermissions
        });
        if (session.workDir) {
          setOriginalCwd(session.workDir);
          setCwdState(session.workDir);
        }
        setDirectConnectServerUrl(serverUrl);
        connectConfig = session.config;
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: intentional error output
        console.error(err instanceof DirectConnectError ? err.message : String(err));
        process.exit(1);
      }
      const {
        runConnectHeadless
      } = await import('./server/connectHeadless.js');
      const prompt = typeof opts.print === 'string' ? opts.print : '';
      const interactive = opts.print === true;
      await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive);
    });
  }

  // claude auth

  const auth = program.command('auth').description('Manage authentication').configureHelp(createSortedHelpConfig());
  auth.command('login').description('Sign in to your Anthropic account').option('--email <email>', 'Pre-populate email address on the login page').option('--sso', 'Force SSO login flow').option('--console', 'Use Anthropic Console (API usage billing) instead of Claude subscription').option('--claudeai', 'Use Claude subscription (default)').action(async ({
    email,
    sso,
    console: useConsole,
    claudeai
  }: {
    email?: string;
    sso?: boolean;
    console?: boolean;
    claudeai?: boolean;
  }) => {
    const {
      authLogin
    } = await import('./cli/handlers/auth.js');
    await authLogin({
      email,
      sso,
      console: useConsole,
      claudeai
    });
  });
  auth.command('status').description('Show authentication status').option('--json', 'Output as JSON (default)').option('--text', 'Output as human-readable text').action(async (opts: {
    json?: boolean;
    text?: boolean;
  }) => {
    const {
      authStatus
    } = await import('./cli/handlers/auth.js');
    await authStatus(opts);
  });
  auth.command('logout').description('Log out from your Anthropic account').action(async () => {
    const {
      authLogout
    } = await import('./cli/handlers/auth.js');
    await authLogout();
  });

  /**
   * Helper function to handle marketplace command errors consistently.
   * Logs the error and exits the process with status 1.
   * @param error The error that occurred
   * @param action Description of the action that failed
   */
  // Hidden flag on all plugin/marketplace subcommands to target cowork_plugins.
  const coworkOption = () => new Option('--cowork', 'Use cowork_plugins directory').hideHelp();

  // Plugin validate command
  const pluginCmd = program.command('plugin').alias('plugins').description('Manage Claude Code plugins').configureHelp(createSortedHelpConfig());
  pluginCmd.command('validate <path>').description('Validate a plugin or marketplace manifest').addOption(coworkOption()).action(async (manifestPath: string, options: {
    cowork?: boolean;
  }) => {
    const {
      pluginValidateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginValidateHandler(manifestPath, options);
  });

  // Plugin list command
  pluginCmd.command('list').description('List installed plugins').option('--json', 'Output as JSON').option('--available', 'Include available plugins from marketplaces (requires --json)').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    available?: boolean;
    cowork?: boolean;
  }) => {
    const {
      pluginListHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginListHandler(options);
  });

  // Marketplace subcommands
  const marketplaceCmd = pluginCmd.command('marketplace').description('Manage Claude Code marketplaces').configureHelp(createSortedHelpConfig());
  marketplaceCmd.command('add <source>').description('Add a marketplace from a URL, path, or GitHub repo').addOption(coworkOption()).option('--sparse <paths...>', 'Limit checkout to specific directories via git sparse-checkout (for monorepos). Example: --sparse .claude-plugin plugins').option('--scope <scope>', 'Where to declare the marketplace: user (default), project, or local').action(async (source: string, options: {
    cowork?: boolean;
    sparse?: string[];
    scope?: string;
  }) => {
    const {
      marketplaceAddHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceAddHandler(source, options);
  });
  marketplaceCmd.command('list').description('List all configured marketplaces').option('--json', 'Output as JSON').addOption(coworkOption()).action(async (options: {
    json?: boolean;
    cowork?: boolean;
  }) => {
    const {
      marketplaceListHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceListHandler(options);
  });
  marketplaceCmd.command('remove <name>').alias('rm').description('Remove a configured marketplace').addOption(coworkOption()).action(async (name: string, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceRemoveHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceRemoveHandler(name, options);
  });
  marketplaceCmd.command('update [name]').description('Update marketplace(s) from their source - updates all if no name specified').addOption(coworkOption()).action(async (name: string | undefined, options: {
    cowork?: boolean;
  }) => {
    const {
      marketplaceUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await marketplaceUpdateHandler(name, options);
  });

  // Plugin install command
  pluginCmd.command('install <plugin>').alias('i').description('Install a plugin from available marketplaces (use plugin@marketplace for specific marketplace)').option('-s, --scope <scope>', 'Installation scope: user, project, or local', 'user').addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginInstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginInstallHandler(plugin, options);
  });

  // Plugin uninstall command
  pluginCmd.command('uninstall <plugin>').alias('remove').alias('rm').description('Uninstall an installed plugin').option('-s, --scope <scope>', 'Uninstall from scope: user, project, or local', 'user').option('--keep-data', "Preserve the plugin's persistent data directory (~/.claude/plugins/data/{id}/)").addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
    keepData?: boolean;
  }) => {
    const {
      pluginUninstallHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUninstallHandler(plugin, options);
  });

  // Plugin enable command
  pluginCmd.command('enable <plugin>').description('Enable a disabled plugin').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginEnableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginEnableHandler(plugin, options);
  });

  // Plugin disable command
  pluginCmd.command('disable [plugin]').description('Disable an enabled plugin').option('-a, --all', 'Disable all enabled plugins').option('-s, --scope <scope>', `Installation scope: ${VALID_INSTALLABLE_SCOPES.join(', ')} (default: auto-detect)`).addOption(coworkOption()).action(async (plugin: string | undefined, options: {
    scope?: string;
    cowork?: boolean;
    all?: boolean;
  }) => {
    const {
      pluginDisableHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginDisableHandler(plugin, options);
  });

  // Plugin update command
  pluginCmd.command('update <plugin>').description('Update a plugin to the latest version (restart required to apply)').option('-s, --scope <scope>', `Installation scope: ${VALID_UPDATE_SCOPES.join(', ')} (default: user)`).addOption(coworkOption()).action(async (plugin: string, options: {
    scope?: string;
    cowork?: boolean;
  }) => {
    const {
      pluginUpdateHandler
    } = await import('./cli/handlers/plugins.js');
    await pluginUpdateHandler(plugin, options);
  });
  // END ANT-ONLY

  // Setup token command
  program.command('setup-token').description('Set up a long-lived authentication token (requires Claude subscription)').action(async () => {
    const [{
      setupTokenHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await setupTokenHandler(root);
  });

  // Agents command - list configured agents
  program.command('agents').description('List configured agents').option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).').action(async () => {
    const {
      agentsHandler
    } = await import('./cli/handlers/agents.js');
    await agentsHandler();
    process.exit(0);
  });
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    // Skip when tengu_auto_mode_config.enabled === 'disabled' (circuit breaker).
    // Reads from disk cache — GrowthBook isn't initialized at registration time.
    if (getAutoModeEnabledStateIfCached() !== 'disabled') {
      const autoModeCmd = program.command('auto-mode').description('Inspect auto mode classifier configuration');
      autoModeCmd.command('defaults').description('Print the default auto mode environment, allow, and deny rules as JSON').action(async () => {
        const {
          autoModeDefaultsHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeDefaultsHandler();
        process.exit(0);
      });
      autoModeCmd.command('config').description('Print the effective auto mode config as JSON: your settings where set, defaults otherwise').action(async () => {
        const {
          autoModeConfigHandler
        } = await import('./cli/handlers/autoMode.js');
        autoModeConfigHandler();
        process.exit(0);
      });
      autoModeCmd.command('critique').description('Get AI feedback on your custom auto mode rules').option('--model <model>', 'Override which model is used').action(async options => {
        const {
          autoModeCritiqueHandler
        } = await import('./cli/handlers/autoMode.js');
        await autoModeCritiqueHandler(options);
        process.exit();
      });
    }
  }

  // Remote Control command — connect local environment to claude.ai/code.
  // The actual command is intercepted by the fast-path in cli.tsx before
  // Commander.js runs, so this registration exists only for help output.
  // Always hidden: isBridgeEnabled() at this point (before enableConfigs)
  // would throw inside isClaudeAISubscriber → getGlobalConfig and return
  // false via the try/catch — but not before paying ~65ms of side effects
  // (25ms settings Zod parse + 40ms sync `security` keychain subprocess).
  // The dynamic visibility never worked; the command was always hidden.
  if (feature('BRIDGE_MODE')) {
    program.command('remote-control', {
      hidden: true
    }).alias('rc').description('Connect your local environment for remote-control sessions via claude.ai/code').action(async () => {
      // Unreachable — cli.tsx fast-path handles this command before main.tsx loads.
      // If somehow reached, delegate to bridgeMain.
      const {
        bridgeMain
      } = await import('./bridge/bridgeMain.js');
      await bridgeMain(process.argv.slice(3));
    });
  }
  if (feature('KAIROS')) {
    program.command('assistant [sessionId]').description('Attach the REPL as a client to a running bridge session. Discovers sessions via API if no sessionId given.').action(() => {
      // Argv rewriting above should have consumed `assistant [id]`
      // before commander runs. Reaching here means a root flag came first
      // (e.g. `--debug assistant`) and the position-0 predicate
      // didn't match. Print usage like the ssh stub does.
      process.stderr.write('Usage: claude assistant [sessionId]\n\n' + 'Attach the REPL as a viewer client to a running bridge session.\n' + 'Omit sessionId to discover and pick from available sessions.\n');
      process.exit(1);
    });
  }

  // Doctor command - check installation health
  program.command('doctor').description('Check the health of your Claude Code auto-updater. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.').action(async () => {
    const [{
      doctorHandler
    }, {
      createRoot
    }] = await Promise.all([import('./cli/handlers/util.js'), import('./ink.js')]);
    const root = await createRoot(getBaseRenderOptions(false));
    await doctorHandler(root);
  });

  // claude update
  //
  // For SemVer-compliant versioning with build metadata (X.X.X+SHA):
  // - We perform exact string comparison (including SHA) to detect any change
  // - This ensures users always get the latest build, even when only the SHA changes
  // - UI shows both versions including build metadata for clarity
  program.command('update').alias('upgrade').description('Check for updates and install if available').action(async () => {
    const {
      update
    } = await import('src/cli/update.js');
    await update();
  });

  // claude up — run the project's CLAUDE.md "# claude up" setup instructions.
  if ("external" === 'ant') {
    program.command('up').description('[ANT-ONLY] Initialize or upgrade the local dev environment using the "# claude up" section of the nearest CLAUDE.md').action(async () => {
      const {
        up
      } = await import('src/cli/up.js');
      await up();
    });
  }

  // claude rollback (ant-only)
  // Rolls back to previous releases
  if ("external" === 'ant') {
    program.command('rollback [target]').description('[ANT-ONLY] Roll back to a previous release\n\nExamples:\n  claude rollback                                    Go 1 version back from current\n  claude rollback 3                                  Go 3 versions back from current\n  claude rollback 2.0.73-dev.20251217.t190658        Roll back to a specific version').option('-l, --list', 'List recent published versions with ages').option('--dry-run', 'Show what would be installed without installing').option('--safe', 'Roll back to the server-pinned safe version (set by oncall during incidents)').action(async (target?: string, options?: {
      list?: boolean;
      dryRun?: boolean;
      safe?: boolean;
    }) => {
      const {
        rollback
      } = await import('src/cli/rollback.js');
      await rollback(target, options);
    });
  }

  // claude install
  program.command('install [target]').description('Install Claude Code native build. Use [target] to specify version (stable, latest, or specific version)').option('--force', 'Force installation even if already installed').action(async (target: string | undefined, options: {
    force?: boolean;
  }) => {
    const {
      installHandler
    } = await import('./cli/handlers/util.js');
    await installHandler(target, options);
  });

  // ant-only commands
  if ("external" === 'ant') {
    const validateLogId = (value: string) => {
      const maybeSessionId = validateUuid(value);
      if (maybeSessionId) return maybeSessionId;
      return Number(value);
    };
    // claude log
    program.command('log').description('[ANT-ONLY] Manage conversation logs.').argument('[number|sessionId]', 'A number (0, 1, 2, etc.) to display a specific log, or the sesssion ID (uuid) of a log', validateLogId).action(async (logId: string | number | undefined) => {
      const {
        logHandler
      } = await import('./cli/handlers/ant.js');
      await logHandler(logId);
    });

    // claude error
    program.command('error').description('[ANT-ONLY] View error logs. Optionally provide a number (0, -1, -2, etc.) to display a specific log.').argument('[number]', 'A number (0, 1, 2, etc.) to display a specific log', parseInt).action(async (number: number | undefined) => {
      const {
        errorHandler
      } = await import('./cli/handlers/ant.js');
      await errorHandler(number);
    });

    // claude export
    program.command('export').description('[ANT-ONLY] Export a conversation to a text file.').usage('<source> <outputFile>').argument('<source>', 'Session ID, log index (0, 1, 2...), or path to a .json/.jsonl log file').argument('<outputFile>', 'Output file path for the exported text').addHelpText('after', `
Examples:
  $ claude export 0 conversation.txt                Export conversation at log index 0
  $ claude export <uuid> conversation.txt           Export conversation by session ID
  $ claude export input.json output.txt             Render JSON log file to text
  $ claude export <uuid>.jsonl output.txt           Render JSONL session file to text`).action(async (source: string, outputFile: string) => {
      const {
        exportHandler
      } = await import('./cli/handlers/ant.js');
      await exportHandler(source, outputFile);
    });
    if ("external" === 'ant') {
      const taskCmd = program.command('task').description('[ANT-ONLY] Manage task list tasks');
      taskCmd.command('create <subject>').description('Create a new task').option('-d, --description <text>', 'Task description').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (subject: string, opts: {
        description?: string;
        list?: string;
      }) => {
        const {
          taskCreateHandler
        } = await import('./cli/handlers/ant.js');
        await taskCreateHandler(subject, opts);
      });
      taskCmd.command('list').description('List all tasks').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').option('--pending', 'Show only pending tasks').option('--json', 'Output as JSON').action(async (opts: {
        list?: string;
        pending?: boolean;
        json?: boolean;
      }) => {
        const {
          taskListHandler
        } = await import('./cli/handlers/ant.js');
        await taskListHandler(opts);
      });
      taskCmd.command('get <id>').description('Get details of a task').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (id: string, opts: {
        list?: string;
      }) => {
        const {
          taskGetHandler
        } = await import('./cli/handlers/ant.js');
        await taskGetHandler(id, opts);
      });
      taskCmd.command('update <id>').description('Update a task').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').option('-s, --status <status>', `Set status (${TASK_STATUSES.join(', ')})`).option('--subject <text>', 'Update subject').option('-d, --description <text>', 'Update description').option('--owner <agentId>', 'Set owner').option('--clear-owner', 'Clear owner').action(async (id: string, opts: {
        list?: string;
        status?: string;
        subject?: string;
        description?: string;
        owner?: string;
        clearOwner?: boolean;
      }) => {
        const {
          taskUpdateHandler
        } = await import('./cli/handlers/ant.js');
        await taskUpdateHandler(id, opts);
      });
      taskCmd.command('dir').description('Show the tasks directory path').option('-l, --list <id>', 'Task list ID (defaults to "tasklist")').action(async (opts: {
        list?: string;
      }) => {
        const {
          taskDirHandler
        } = await import('./cli/handlers/ant.js');
        await taskDirHandler(opts);
      });
    }

    // claude completion <shell>
    program.command('completion <shell>', {
      hidden: true
    }).description('Generate shell completion script (bash, zsh, or fish)').option('--output <file>', 'Write completion script directly to a file instead of stdout').action(async (shell: string, opts: {
      output?: string;
    }) => {
      const {
        completionHandler
      } = await import('./cli/handlers/ant.js');
      await completionHandler(shell, opts, program);
    });
  }
  profileCheckpoint('run_before_parse');
  await program.parseAsync(process.argv);
  profileCheckpoint('run_after_parse');

  // Record final checkpoint for total_time calculation
  profileCheckpoint('main_after_run');

  // Log startup perf to Statsig (sampled) and output detailed report if enabled
  profileReport();
  return program;
}
async function logTenguInit({
  hasInitialPrompt,
  hasStdin,
  verbose,
  debug,
  debugToStderr,
  print,
  outputFormat,
  inputFormat,
  numAllowedTools,
  numDisallowedTools,
  mcpClientCount,
  worktreeEnabled,
  skipWebFetchPreflight,
  githubActionInputs,
  dangerouslySkipPermissionsPassed,
  permissionMode,
  modeIsBypass,
  allowDangerouslySkipPermissionsPassed,
  systemPromptFlag,
  appendSystemPromptFlag,
  thinkingConfig,
  assistantActivationPath
}: {
  hasInitialPrompt: boolean;
  hasStdin: boolean;
  verbose: boolean;
  debug: boolean;
  debugToStderr: boolean;
  print: boolean;
  outputFormat: string;
  inputFormat: string;
  numAllowedTools: number;
  numDisallowedTools: number;
  mcpClientCount: number;
  worktreeEnabled: boolean;
  skipWebFetchPreflight: boolean | undefined;
  githubActionInputs: string | undefined;
  dangerouslySkipPermissionsPassed: boolean;
  permissionMode: string;
  modeIsBypass: boolean;
  allowDangerouslySkipPermissionsPassed: boolean;
  systemPromptFlag: 'file' | 'flag' | undefined;
  appendSystemPromptFlag: 'file' | 'flag' | undefined;
  thinkingConfig: ThinkingConfig;
  assistantActivationPath: string | undefined;
}): Promise<void> {
  try {
    logEvent('tengu_init', {
      entrypoint: 'claude' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      hasInitialPrompt,
      hasStdin,
      verbose,
      debug,
      debugToStderr,
      print,
      outputFormat: outputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      inputFormat: inputFormat as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      numAllowedTools,
      numDisallowedTools,
      mcpClientCount,
      worktree: worktreeEnabled,
      skipWebFetchPreflight,
      ...(githubActionInputs && {
        githubActionInputs: githubActionInputs as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      dangerouslySkipPermissionsPassed,
      permissionMode: permissionMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      modeIsBypass,
      inProtectedNamespace: isInProtectedNamespace(),
      allowDangerouslySkipPermissionsPassed,
      thinkingType: thinkingConfig.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...(systemPromptFlag && {
        systemPromptFlag: systemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      ...(appendSystemPromptFlag && {
        appendSystemPromptFlag: appendSystemPromptFlag as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      is_simple: isBareMode() || undefined,
      is_coordinator: feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode() ? true : undefined,
      ...(assistantActivationPath && {
        assistantActivationPath: assistantActivationPath as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      }),
      autoUpdatesChannel: (getInitialSettings().autoUpdatesChannel ?? 'latest') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...("external" === 'ant' ? (() => {
        const cwd = getCwd();
        const gitRoot = findGitRoot(cwd);
        const rp = gitRoot ? relative(gitRoot, cwd) || '.' : undefined;
        return rp ? {
          relativeProjectPath: rp as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
        } : {};
      })() : {})
    });
  } catch (error) {
    logError(error);
  }
}
function maybeActivateProactive(options: unknown): void {
  if ((feature('PROACTIVE') || feature('KAIROS')) && ((options as {
    proactive?: boolean;
  }).proactive || isEnvTruthy(process.env.CLAUDE_CODE_PROACTIVE))) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const proactiveModule = require('./proactive/index.js');
    if (!proactiveModule.isProactiveActive()) {
      proactiveModule.activateProactive('command');
    }
  }
}
function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return;
  const briefFlag = (options as {
    brief?: boolean;
  }).brief;
  const briefEnv = isEnvTruthy(process.env.CLAUDE_CODE_BRIEF);
  if (!briefFlag && !briefEnv) return;
  // --brief / CLAUDE_CODE_BRIEF are explicit opt-ins: check entitlement,
  // then set userMsgOptIn to activate the tool + prompt section. The env
  // var also grants entitlement (isBriefEntitled() reads it), so setting
  // CLAUDE_CODE_BRIEF=1 alone force-enables for dev/testing — no GB gate
  // needed. initialIsBriefOnly reads getUserMsgOptIn() directly.
  // Conditional require: static import would leak the tool name string
  // into external builds via BriefTool.ts → prompt.ts.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const {
    isBriefEntitled
  } = require('./tools/BriefTool/BriefTool.js') as typeof import('./tools/BriefTool/BriefTool.js');
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled();
  if (entitled) {
    setUserMsgOptIn(true);
  }
  // Fire unconditionally once intent is seen: enabled=false captures the
  // "user tried but was gated" failure mode in Datadog.
  logEvent('tengu_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv ? 'env' : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
}
function resetCursor() {
  const terminal = process.stderr.isTTY ? process.stderr : process.stdout.isTTY ? process.stdout : undefined;
  terminal?.write(SHOW_CURSOR);
}
type TeammateOptions = {
  agentId?: string;
  agentName?: string;
  teamName?: string;
  agentColor?: string;
  planModeRequired?: boolean;
  parentSessionId?: string;
  teammateMode?: 'auto' | 'tmux' | 'in-process';
  agentType?: string;
};
function extractTeammateOptions(options: unknown): TeammateOptions {
  if (typeof options !== 'object' || options === null) {
    return {};
  }
  const opts = options as Record<string, unknown>;
  const teammateMode = opts.teammateMode;
  return {
    agentId: typeof opts.agentId === 'string' ? opts.agentId : undefined,
    agentName: typeof opts.agentName === 'string' ? opts.agentName : undefined,
    teamName: typeof opts.teamName === 'string' ? opts.teamName : undefined,
    agentColor: typeof opts.agentColor === 'string' ? opts.agentColor : undefined,
    planModeRequired: typeof opts.planModeRequired === 'boolean' ? opts.planModeRequired : undefined,
    parentSessionId: typeof opts.parentSessionId === 'string' ? opts.parentSessionId : undefined,
    teammateMode: teammateMode === 'auto' || teammateMode === 'tmux' || teammateMode === 'in-process' ? teammateMode : undefined,
    agentType: typeof opts.agentType === 'string' ? opts.agentType : undefined
  };
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJwcm9maWxlQ2hlY2twb2ludCIsInByb2ZpbGVSZXBvcnQiLCJzdGFydE1kbVJhd1JlYWQiLCJlbnN1cmVLZXljaGFpblByZWZldGNoQ29tcGxldGVkIiwic3RhcnRLZXljaGFpblByZWZldGNoIiwiZmVhdHVyZSIsIkNvbW1hbmQiLCJDb21tYW5kZXJDb21tYW5kIiwiSW52YWxpZEFyZ3VtZW50RXJyb3IiLCJPcHRpb24iLCJjaGFsayIsInJlYWRGaWxlU3luYyIsIm1hcFZhbHVlcyIsInBpY2tCeSIsInVuaXFCeSIsIlJlYWN0IiwiZ2V0T2F1dGhDb25maWciLCJnZXRSZW1vdGVTZXNzaW9uVXJsIiwiZ2V0U3lzdGVtQ29udGV4dCIsImdldFVzZXJDb250ZXh0IiwiaW5pdCIsImluaXRpYWxpemVUZWxlbWV0cnlBZnRlclRydXN0IiwiYWRkVG9IaXN0b3J5IiwiUm9vdCIsImxhdW5jaFJlcGwiLCJoYXNHcm93dGhCb29rRW52T3ZlcnJpZGUiLCJpbml0aWFsaXplR3Jvd3RoQm9vayIsInJlZnJlc2hHcm93dGhCb29rQWZ0ZXJBdXRoQ2hhbmdlIiwiZmV0Y2hCb290c3RyYXBEYXRhIiwiRG93bmxvYWRSZXN1bHQiLCJkb3dubG9hZFNlc3Npb25GaWxlcyIsIkZpbGVzQXBpQ29uZmlnIiwicGFyc2VGaWxlU3BlY3MiLCJwcmVmZXRjaFBhc3Nlc0VsaWdpYmlsaXR5IiwicHJlZmV0Y2hPZmZpY2lhbE1jcFVybHMiLCJNY3BTZGtTZXJ2ZXJDb25maWciLCJNY3BTZXJ2ZXJDb25maWciLCJTY29wZWRNY3BTZXJ2ZXJDb25maWciLCJpc1BvbGljeUFsbG93ZWQiLCJsb2FkUG9saWN5TGltaXRzIiwicmVmcmVzaFBvbGljeUxpbWl0cyIsIndhaXRGb3JQb2xpY3lMaW1pdHNUb0xvYWQiLCJsb2FkUmVtb3RlTWFuYWdlZFNldHRpbmdzIiwicmVmcmVzaFJlbW90ZU1hbmFnZWRTZXR0aW5ncyIsIlRvb2xJbnB1dEpTT05TY2hlbWEiLCJjcmVhdGVTeW50aGV0aWNPdXRwdXRUb29sIiwiaXNTeW50aGV0aWNPdXRwdXRUb29sRW5hYmxlZCIsImdldFRvb2xzIiwiY2FuVXNlckNvbmZpZ3VyZUFkdmlzb3IiLCJnZXRJbml0aWFsQWR2aXNvclNldHRpbmciLCJpc0Fkdmlzb3JFbmFibGVkIiwiaXNWYWxpZEFkdmlzb3JNb2RlbCIsIm1vZGVsU3VwcG9ydHNBZHZpc29yIiwiaXNBZ2VudFN3YXJtc0VuYWJsZWQiLCJjb3VudCIsInVuaXEiLCJpbnN0YWxsQXNjaWljYXN0UmVjb3JkZXIiLCJnZXRTdWJzY3JpcHRpb25UeXBlIiwiaXNDbGF1ZGVBSVN1YnNjcmliZXIiLCJwcmVmZXRjaEF3c0NyZWRlbnRpYWxzQW5kQmVkUm9ja0luZm9JZlNhZmUiLCJwcmVmZXRjaEdjcENyZWRlbnRpYWxzSWZTYWZlIiwidmFsaWRhdGVGb3JjZUxvZ2luT3JnIiwiY2hlY2tIYXNUcnVzdERpYWxvZ0FjY2VwdGVkIiwiZ2V0R2xvYmFsQ29uZmlnIiwiZ2V0UmVtb3RlQ29udHJvbEF0U3RhcnR1cCIsImlzQXV0b1VwZGF0ZXJEaXNhYmxlZCIsInNhdmVHbG9iYWxDb25maWciLCJzZWVkRWFybHlJbnB1dCIsInN0b3BDYXB0dXJpbmdFYXJseUlucHV0IiwiZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmciLCJwYXJzZUVmZm9ydFZhbHVlIiwiZ2V0SW5pdGlhbEZhc3RNb2RlU2V0dGluZyIsImlzRmFzdE1vZGVFbmFibGVkIiwicHJlZmV0Y2hGYXN0TW9kZVN0YXR1cyIsInJlc29sdmVGYXN0TW9kZVN0YXR1c0Zyb21DYWNoZSIsImFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMiLCJjcmVhdGVTeXN0ZW1NZXNzYWdlIiwiY3JlYXRlVXNlck1lc3NhZ2UiLCJnZXRQbGF0Zm9ybSIsImdldEJhc2VSZW5kZXJPcHRpb25zIiwiZ2V0U2Vzc2lvbkluZ3Jlc3NBdXRoVG9rZW4iLCJzZXR0aW5nc0NoYW5nZURldGVjdG9yIiwic2tpbGxDaGFuZ2VEZXRlY3RvciIsImpzb25QYXJzZSIsIndyaXRlRmlsZVN5bmNfREVQUkVDQVRFRCIsImNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQiLCJpbml0aWFsaXplV2FybmluZ0hhbmRsZXIiLCJpc1dvcmt0cmVlTW9kZUVuYWJsZWQiLCJnZXRUZWFtbWF0ZVV0aWxzIiwicmVxdWlyZSIsImdldFRlYW1tYXRlUHJvbXB0QWRkZW5kdW0iLCJnZXRUZWFtbWF0ZU1vZGVTbmFwc2hvdCIsImNvb3JkaW5hdG9yTW9kZU1vZHVsZSIsImFzc2lzdGFudE1vZHVsZSIsImthaXJvc0dhdGUiLCJyZWxhdGl2ZSIsInJlc29sdmUiLCJpc0FuYWx5dGljc0Rpc2FibGVkIiwiZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUiLCJBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTIiwibG9nRXZlbnQiLCJpbml0aWFsaXplQW5hbHl0aWNzR2F0ZXMiLCJnZXRPcmlnaW5hbEN3ZCIsInNldEFkZGl0aW9uYWxEaXJlY3Rvcmllc0ZvckNsYXVkZU1kIiwic2V0SXNSZW1vdGVNb2RlIiwic2V0TWFpbkxvb3BNb2RlbE92ZXJyaWRlIiwic2V0TWFpblRocmVhZEFnZW50VHlwZSIsInNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyIsImZpbHRlckNvbW1hbmRzRm9yUmVtb3RlTW9kZSIsImdldENvbW1hbmRzIiwiU3RhdHNTdG9yZSIsImxhdW5jaEFzc2lzdGFudEluc3RhbGxXaXphcmQiLCJsYXVuY2hBc3Npc3RhbnRTZXNzaW9uQ2hvb3NlciIsImxhdW5jaEludmFsaWRTZXR0aW5nc0RpYWxvZyIsImxhdW5jaFJlc3VtZUNob29zZXIiLCJsYXVuY2hTbmFwc2hvdFVwZGF0ZURpYWxvZyIsImxhdW5jaFRlbGVwb3J0UmVwb01pc21hdGNoRGlhbG9nIiwibGF1bmNoVGVsZXBvcnRSZXN1bWVXcmFwcGVyIiwiU0hPV19DVVJTT1IiLCJleGl0V2l0aEVycm9yIiwiZXhpdFdpdGhNZXNzYWdlIiwiZ2V0UmVuZGVyQ29udGV4dCIsInJlbmRlckFuZFJ1biIsInNob3dTZXR1cFNjcmVlbnMiLCJpbml0QnVpbHRpblBsdWdpbnMiLCJjaGVja1F1b3RhU3RhdHVzIiwiZ2V0TWNwVG9vbHNDb21tYW5kc0FuZFJlc291cmNlcyIsInByZWZldGNoQWxsTWNwUmVzb3VyY2VzIiwiVkFMSURfSU5TVEFMTEFCTEVfU0NPUEVTIiwiVkFMSURfVVBEQVRFX1NDT1BFUyIsImluaXRCdW5kbGVkU2tpbGxzIiwiQWdlbnRDb2xvck5hbWUiLCJnZXRBY3RpdmVBZ2VudHNGcm9tTGlzdCIsImdldEFnZW50RGVmaW5pdGlvbnNXaXRoT3ZlcnJpZGVzIiwiaXNCdWlsdEluQWdlbnQiLCJpc0N1c3RvbUFnZW50IiwicGFyc2VBZ2VudHNGcm9tSnNvbiIsIkxvZ09wdGlvbiIsIk1lc3NhZ2UiLCJNZXNzYWdlVHlwZSIsImFzc2VydE1pblZlcnNpb24iLCJDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlQiLCJDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlRfV0lUSF9XRUJCUk9XU0VSIiwic2V0dXBDbGF1ZGVJbkNocm9tZSIsInNob3VsZEF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSIsInNob3VsZEVuYWJsZUNsYXVkZUluQ2hyb21lIiwiZ2V0Q29udGV4dFdpbmRvd0Zvck1vZGVsIiwibG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZSIsImJ1aWxkRGVlcExpbmtCYW5uZXIiLCJoYXNOb2RlT3B0aW9uIiwiaXNCYXJlTW9kZSIsImlzRW52VHJ1dGh5IiwiaXNJblByb3RlY3RlZE5hbWVzcGFjZSIsInJlZnJlc2hFeGFtcGxlQ29tbWFuZHMiLCJGcHNNZXRyaWNzIiwiZ2V0V29ya3RyZWVQYXRocyIsImZpbmRHaXRSb290IiwiZ2V0QnJhbmNoIiwiZ2V0SXNHaXQiLCJnZXRXb3JrdHJlZUNvdW50IiwiZ2V0R2hBdXRoU3RhdHVzIiwic2FmZVBhcnNlSlNPTiIsImxvZ0Vycm9yIiwiZ2V0TW9kZWxEZXByZWNhdGlvbldhcm5pbmciLCJnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCIsImdldFVzZXJTcGVjaWZpZWRNb2RlbFNldHRpbmciLCJub3JtYWxpemVNb2RlbFN0cmluZ0ZvckFQSSIsInBhcnNlVXNlclNwZWNpZmllZE1vZGVsIiwiZW5zdXJlTW9kZWxTdHJpbmdzSW5pdGlhbGl6ZWQiLCJQRVJNSVNTSU9OX01PREVTIiwiY2hlY2tBbmREaXNhYmxlQnlwYXNzUGVybWlzc2lvbnMiLCJnZXRBdXRvTW9kZUVuYWJsZWRTdGF0ZUlmQ2FjaGVkIiwiaW5pdGlhbGl6ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCIsImluaXRpYWxQZXJtaXNzaW9uTW9kZUZyb21DTEkiLCJpc0RlZmF1bHRQZXJtaXNzaW9uTW9kZUF1dG8iLCJwYXJzZVRvb2xMaXN0RnJvbUNMSSIsInJlbW92ZURhbmdlcm91c1Blcm1pc3Npb25zIiwic3RyaXBEYW5nZXJvdXNQZXJtaXNzaW9uc0ZvckF1dG9Nb2RlIiwidmVyaWZ5QXV0b01vZGVHYXRlQWNjZXNzIiwiY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQiLCJpbml0aWFsaXplVmVyc2lvbmVkUGx1Z2lucyIsImdldE1hbmFnZWRQbHVnaW5OYW1lcyIsImdldEdsb2JFeGNsdXNpb25zRm9yUGx1Z2luQ2FjaGUiLCJnZXRQbHVnaW5TZWVkRGlycyIsImNvdW50RmlsZXNSb3VuZGVkUmciLCJwcm9jZXNzU2Vzc2lvblN0YXJ0SG9va3MiLCJwcm9jZXNzU2V0dXBIb29rcyIsImNhY2hlU2Vzc2lvblRpdGxlIiwiZ2V0U2Vzc2lvbklkRnJvbUxvZyIsImxvYWRUcmFuc2NyaXB0RnJvbUZpbGUiLCJzYXZlQWdlbnRTZXR0aW5nIiwic2F2ZU1vZGUiLCJzZWFyY2hTZXNzaW9uc0J5Q3VzdG9tVGl0bGUiLCJzZXNzaW9uSWRFeGlzdHMiLCJlbnN1cmVNZG1TZXR0aW5nc0xvYWRlZCIsImdldEluaXRpYWxTZXR0aW5ncyIsImdldE1hbmFnZWRTZXR0aW5nc0tleXNGb3JMb2dnaW5nIiwiZ2V0U2V0dGluZ3NGb3JTb3VyY2UiLCJnZXRTZXR0aW5nc1dpdGhFcnJvcnMiLCJyZXNldFNldHRpbmdzQ2FjaGUiLCJWYWxpZGF0aW9uRXJyb3IiLCJERUZBVUxUX1RBU0tTX01PREVfVEFTS19MSVNUX0lEIiwiVEFTS19TVEFUVVNFUyIsImxvZ1BsdWdpbkxvYWRFcnJvcnMiLCJsb2dQbHVnaW5zRW5hYmxlZEZvclNlc3Npb24iLCJsb2dTa2lsbHNMb2FkZWQiLCJnZW5lcmF0ZVRlbXBGaWxlUGF0aCIsInZhbGlkYXRlVXVpZCIsInJlZ2lzdGVyTWNwQWRkQ29tbWFuZCIsInJlZ2lzdGVyTWNwWGFhSWRwQ29tbWFuZCIsImxvZ1Blcm1pc3Npb25Db250ZXh0Rm9yQW50cyIsImZldGNoQ2xhdWRlQUlNY3BDb25maWdzSWZFbGlnaWJsZSIsImNsZWFyU2VydmVyQ2FjaGUiLCJhcmVNY3BDb25maWdzQWxsb3dlZFdpdGhFbnRlcnByaXNlTWNwQ29uZmlnIiwiZGVkdXBDbGF1ZGVBaU1jcFNlcnZlcnMiLCJkb2VzRW50ZXJwcmlzZU1jcENvbmZpZ0V4aXN0IiwiZmlsdGVyTWNwU2VydmVyc0J5UG9saWN5IiwiZ2V0Q2xhdWRlQ29kZU1jcENvbmZpZ3MiLCJnZXRNY3BTZXJ2ZXJTaWduYXR1cmUiLCJwYXJzZU1jcENvbmZpZyIsInBhcnNlTWNwQ29uZmlnRnJvbUZpbGVQYXRoIiwiZXhjbHVkZUNvbW1hbmRzQnlTZXJ2ZXIiLCJleGNsdWRlUmVzb3VyY2VzQnlTZXJ2ZXIiLCJpc1hhYUVuYWJsZWQiLCJnZXRSZWxldmFudFRpcHMiLCJsb2dDb250ZXh0TWV0cmljcyIsIkNMQVVERV9JTl9DSFJPTUVfTUNQX1NFUlZFUl9OQU1FIiwiaXNDbGF1ZGVJbkNocm9tZU1DUFNlcnZlciIsInJlZ2lzdGVyQ2xlYW51cCIsImVhZ2VyUGFyc2VDbGlGbGFnIiwiY3JlYXRlRW1wdHlBdHRyaWJ1dGlvblN0YXRlIiwiY291bnRDb25jdXJyZW50U2Vzc2lvbnMiLCJyZWdpc3RlclNlc3Npb24iLCJ1cGRhdGVTZXNzaW9uTmFtZSIsImdldEN3ZCIsImxvZ0ZvckRlYnVnZ2luZyIsInNldEhhc0Zvcm1hdHRlZE91dHB1dCIsImVycm9yTWVzc2FnZSIsImdldEVycm5vQ29kZSIsImlzRU5PRU5UIiwiVGVsZXBvcnRPcGVyYXRpb25FcnJvciIsInRvRXJyb3IiLCJnZXRGc0ltcGxlbWVudGF0aW9uIiwic2FmZVJlc29sdmVQYXRoIiwiZ3JhY2VmdWxTaHV0ZG93biIsImdyYWNlZnVsU2h1dGRvd25TeW5jIiwic2V0QWxsSG9va0V2ZW50c0VuYWJsZWQiLCJyZWZyZXNoTW9kZWxDYXBhYmlsaXRpZXMiLCJwZWVrRm9yU3RkaW5EYXRhIiwid3JpdGVUb1N0ZGVyciIsInNldEN3ZCIsIlByb2Nlc3NlZFJlc3VtZSIsInByb2Nlc3NSZXN1bWVkQ29udmVyc2F0aW9uIiwicGFyc2VTZXR0aW5nU291cmNlc0ZsYWciLCJwbHVyYWwiLCJDaGFubmVsRW50cnkiLCJnZXRJbml0aWFsTWFpbkxvb3BNb2RlbCIsImdldElzTm9uSW50ZXJhY3RpdmVTZXNzaW9uIiwiZ2V0U2RrQmV0YXMiLCJnZXRTZXNzaW9uSWQiLCJnZXRVc2VyTXNnT3B0SW4iLCJzZXRBbGxvd2VkQ2hhbm5lbHMiLCJzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMiLCJzZXRDaHJvbWVGbGFnT3ZlcnJpZGUiLCJzZXRDbGllbnRUeXBlIiwic2V0Q3dkU3RhdGUiLCJzZXREaXJlY3RDb25uZWN0U2VydmVyVXJsIiwic2V0RmxhZ1NldHRpbmdzUGF0aCIsInNldEluaXRpYWxNYWluTG9vcE1vZGVsIiwic2V0SW5saW5lUGx1Z2lucyIsInNldElzSW50ZXJhY3RpdmUiLCJzZXRLYWlyb3NBY3RpdmUiLCJzZXRPcmlnaW5hbEN3ZCIsInNldFF1ZXN0aW9uUHJldmlld0Zvcm1hdCIsInNldFNka0JldGFzIiwic2V0U2Vzc2lvbkJ5cGFzc1Blcm1pc3Npb25zTW9kZSIsInNldFNlc3Npb25QZXJzaXN0ZW5jZURpc2FibGVkIiwic2V0U2Vzc2lvblNvdXJjZSIsInNldFVzZXJNc2dPcHRJbiIsInN3aXRjaFNlc3Npb24iLCJhdXRvTW9kZVN0YXRlTW9kdWxlIiwibWlncmF0ZUF1dG9VcGRhdGVzVG9TZXR0aW5ncyIsIm1pZ3JhdGVCeXBhc3NQZXJtaXNzaW9uc0FjY2VwdGVkVG9TZXR0aW5ncyIsIm1pZ3JhdGVFbmFibGVBbGxQcm9qZWN0TWNwU2VydmVyc1RvU2V0dGluZ3MiLCJtaWdyYXRlRmVubmVjVG9PcHVzIiwibWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQiLCJtaWdyYXRlT3B1c1RvT3B1czFtIiwibWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwIiwibWlncmF0ZVNvbm5ldDFtVG9Tb25uZXQ0NSIsIm1pZ3JhdGVTb25uZXQ0NVRvU29ubmV0NDYiLCJyZXNldEF1dG9Nb2RlT3B0SW5Gb3JEZWZhdWx0T2ZmZXIiLCJyZXNldFByb1RvT3B1c0RlZmF1bHQiLCJjcmVhdGVSZW1vdGVTZXNzaW9uQ29uZmlnIiwiY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24iLCJEaXJlY3RDb25uZWN0RXJyb3IiLCJpbml0aWFsaXplTHNwU2VydmVyTWFuYWdlciIsInNob3VsZEVuYWJsZVByb21wdFN1Z2dlc3Rpb24iLCJBcHBTdGF0ZSIsImdldERlZmF1bHRBcHBTdGF0ZSIsIklETEVfU1BFQ1VMQVRJT05fU1RBVEUiLCJvbkNoYW5nZUFwcFN0YXRlIiwiY3JlYXRlU3RvcmUiLCJhc1Nlc3Npb25JZCIsImZpbHRlckFsbG93ZWRTZGtCZXRhcyIsImlzSW5CdW5kbGVkTW9kZSIsImlzUnVubmluZ1dpdGhCdW4iLCJsb2dGb3JEaWFnbm9zdGljc05vUElJIiwiZmlsdGVyRXhpc3RpbmdQYXRocyIsImdldEtub3duUGF0aHNGb3JSZXBvIiwiY2xlYXJQbHVnaW5DYWNoZSIsImxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5IiwibWlncmF0ZUNoYW5nZWxvZ0Zyb21Db25maWciLCJTYW5kYm94TWFuYWdlciIsImZldGNoU2Vzc2lvbiIsInByZXBhcmVBcGlSZXF1ZXN0IiwiY2hlY2tPdXRUZWxlcG9ydGVkU2Vzc2lvbkJyYW5jaCIsInByb2Nlc3NNZXNzYWdlc0ZvclRlbGVwb3J0UmVzdW1lIiwidGVsZXBvcnRUb1JlbW90ZVdpdGhFcnJvckhhbmRsaW5nIiwidmFsaWRhdGVHaXRTdGF0ZSIsInZhbGlkYXRlU2Vzc2lvblJlcG9zaXRvcnkiLCJzaG91bGRFbmFibGVUaGlua2luZ0J5RGVmYXVsdCIsIlRoaW5raW5nQ29uZmlnIiwiaW5pdFVzZXIiLCJyZXNldFVzZXJDYWNoZSIsImdldFRtdXhJbnN0YWxsSW5zdHJ1Y3Rpb25zIiwiaXNUbXV4QXZhaWxhYmxlIiwicGFyc2VQUlJlZmVyZW5jZSIsImxvZ01hbmFnZWRTZXR0aW5ncyIsInBvbGljeVNldHRpbmdzIiwiYWxsS2V5cyIsImtleUNvdW50IiwibGVuZ3RoIiwia2V5cyIsImpvaW4iLCJpc0JlaW5nRGVidWdnZWQiLCJpc0J1biIsImhhc0luc3BlY3RBcmciLCJwcm9jZXNzIiwiZXhlY0FyZ3YiLCJzb21lIiwiYXJnIiwidGVzdCIsImhhc0luc3BlY3RFbnYiLCJlbnYiLCJOT0RFX09QVElPTlMiLCJpbnNwZWN0b3IiLCJnbG9iYWwiLCJoYXNJbnNwZWN0b3JVcmwiLCJ1cmwiLCJleGl0IiwibG9nU2Vzc2lvblRlbGVtZXRyeSIsIm1vZGVsIiwidGhlbiIsImVuYWJsZWQiLCJlcnJvcnMiLCJtYW5hZ2VkTmFtZXMiLCJjYXRjaCIsImVyciIsImdldENlcnRFbnZWYXJUZWxlbWV0cnkiLCJSZWNvcmQiLCJyZXN1bHQiLCJOT0RFX0VYVFJBX0NBX0NFUlRTIiwiaGFzX25vZGVfZXh0cmFfY2FfY2VydHMiLCJDTEFVREVfQ09ERV9DTElFTlRfQ0VSVCIsImhhc19jbGllbnRfY2VydCIsImhhc191c2Vfc3lzdGVtX2NhIiwiaGFzX3VzZV9vcGVuc3NsX2NhIiwibG9nU3RhcnR1cFRlbGVtZXRyeSIsIlByb21pc2UiLCJpc0dpdCIsIndvcmt0cmVlQ291bnQiLCJnaEF1dGhTdGF0dXMiLCJhbGwiLCJpc19naXQiLCJ3b3JrdHJlZV9jb3VudCIsImdoX2F1dGhfc3RhdHVzIiwic2FuZGJveF9lbmFibGVkIiwiaXNTYW5kYm94aW5nRW5hYmxlZCIsImFyZV91bnNhbmRib3hlZF9jb21tYW5kc19hbGxvd2VkIiwiYXJlVW5zYW5kYm94ZWRDb21tYW5kc0FsbG93ZWQiLCJpc19hdXRvX2Jhc2hfYWxsb3dlZF9pZl9zYW5kYm94X2VuYWJsZWQiLCJpc0F1dG9BbGxvd0Jhc2hJZlNhbmRib3hlZEVuYWJsZWQiLCJhdXRvX3VwZGF0ZXJfZGlzYWJsZWQiLCJwcmVmZXJzX3JlZHVjZWRfbW90aW9uIiwicHJlZmVyc1JlZHVjZWRNb3Rpb24iLCJDVVJSRU5UX01JR1JBVElPTl9WRVJTSU9OIiwicnVuTWlncmF0aW9ucyIsIm1pZ3JhdGlvblZlcnNpb24iLCJwcmV2IiwicHJlZmV0Y2hTeXN0ZW1Db250ZXh0SWZTYWZlIiwiaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24iLCJoYXNUcnVzdCIsInN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzIiwiQ0xBVURFX0NPREVfRVhJVF9BRlRFUl9GSVJTVF9SRU5ERVIiLCJDTEFVREVfQ09ERV9VU0VfQkVEUk9DSyIsIkNMQVVERV9DT0RFX1NLSVBfQkVEUk9DS19BVVRIIiwiQ0xBVURFX0NPREVfVVNFX1ZFUlRFWCIsIkNMQVVERV9DT0RFX1NLSVBfVkVSVEVYX0FVVEgiLCJBYm9ydFNpZ25hbCIsInRpbWVvdXQiLCJpbml0aWFsaXplIiwibSIsInN0YXJ0RXZlbnRMb29wU3RhbGxEZXRlY3RvciIsImxvYWRTZXR0aW5nc0Zyb21GbGFnIiwic2V0dGluZ3NGaWxlIiwidHJpbW1lZFNldHRpbmdzIiwidHJpbSIsImxvb2tzTGlrZUpzb24iLCJzdGFydHNXaXRoIiwiZW5kc1dpdGgiLCJzZXR0aW5nc1BhdGgiLCJwYXJzZWRKc29uIiwic3RkZXJyIiwid3JpdGUiLCJyZWQiLCJjb250ZW50SGFzaCIsInJlc29sdmVkUGF0aCIsInJlc29sdmVkU2V0dGluZ3NQYXRoIiwiZSIsImVycm9yIiwiRXJyb3IiLCJsb2FkU2V0dGluZ1NvdXJjZXNGcm9tRmxhZyIsInNldHRpbmdTb3VyY2VzQXJnIiwic291cmNlcyIsImVhZ2VyTG9hZFNldHRpbmdzIiwidW5kZWZpbmVkIiwiaW5pdGlhbGl6ZUVudHJ5cG9pbnQiLCJpc05vbkludGVyYWN0aXZlIiwiQ0xBVURFX0NPREVfRU5UUllQT0lOVCIsImNsaUFyZ3MiLCJhcmd2Iiwic2xpY2UiLCJtY3BJbmRleCIsImluZGV4T2YiLCJDTEFVREVfQ09ERV9BQ1RJT04iLCJQZW5kaW5nQ29ubmVjdCIsImF1dGhUb2tlbiIsImRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zIiwiX3BlbmRpbmdDb25uZWN0IiwiUGVuZGluZ0Fzc2lzdGFudENoYXQiLCJzZXNzaW9uSWQiLCJkaXNjb3ZlciIsIl9wZW5kaW5nQXNzaXN0YW50Q2hhdCIsIlBlbmRpbmdTU0giLCJob3N0IiwiY3dkIiwicGVybWlzc2lvbk1vZGUiLCJsb2NhbCIsImV4dHJhQ2xpQXJncyIsIl9wZW5kaW5nU1NIIiwibWFpbiIsIk5vRGVmYXVsdEN1cnJlbnREaXJlY3RvcnlJbkV4ZVBhdGgiLCJvbiIsInJlc2V0Q3Vyc29yIiwiaW5jbHVkZXMiLCJyYXdDbGlBcmdzIiwiY2NJZHgiLCJmaW5kSW5kZXgiLCJhIiwiY2NVcmwiLCJwYXJzZUNvbm5lY3RVcmwiLCJwYXJzZWQiLCJzdHJpcHBlZCIsImZpbHRlciIsIl8iLCJpIiwiZHNwSWR4Iiwic3BsaWNlIiwic2VydmVyVXJsIiwiaGFuZGxlVXJpSWR4IiwiZW5hYmxlQ29uZmlncyIsInVyaSIsImhhbmRsZURlZXBMaW5rVXJpIiwiZXhpdENvZGUiLCJwbGF0Zm9ybSIsIl9fQ0ZCdW5kbGVJZGVudGlmaWVyIiwiaGFuZGxlVXJsU2NoZW1lTGF1bmNoIiwidXJsU2NoZW1lUmVzdWx0IiwicmF3QXJncyIsIm5leHRBcmciLCJsb2NhbElkeCIsInBtSWR4IiwicG1FcUlkeCIsInNwbGl0IiwiZXh0cmFjdEZsYWciLCJmbGFnIiwib3B0cyIsImhhc1ZhbHVlIiwiYXMiLCJwdXNoIiwidmFsIiwiZXFJIiwiY29uc3VtZWQiLCJyZXN0IiwiaGFzUHJpbnRGbGFnIiwiaGFzSW5pdE9ubHlGbGFnIiwiaGFzU2RrVXJsIiwic3Rkb3V0IiwiaXNUVFkiLCJpc0ludGVyYWN0aXZlIiwiY2xpZW50VHlwZSIsIkdJVEhVQl9BQ1RJT05TIiwiaGFzU2Vzc2lvbkluZ3Jlc3NUb2tlbiIsIkNMQVVERV9DT0RFX1NFU1NJT05fQUNDRVNTX1RPS0VOIiwiQ0xBVURFX0NPREVfV0VCU09DS0VUX0FVVEhfRklMRV9ERVNDUklQVE9SIiwicHJldmlld0Zvcm1hdCIsIkNMQVVERV9DT0RFX1FVRVNUSU9OX1BSRVZJRVdfRk9STUFUIiwiQ0xBVURFX0NPREVfRU5WSVJPTk1FTlRfS0lORCIsInJ1biIsImdldElucHV0UHJvbXB0IiwicHJvbXB0IiwiaW5wdXRGb3JtYXQiLCJBc3luY0l0ZXJhYmxlIiwic3RkaW4iLCJzZXRFbmNvZGluZyIsImRhdGEiLCJvbkRhdGEiLCJjaHVuayIsInRpbWVkT3V0Iiwib2ZmIiwiQm9vbGVhbiIsImNyZWF0ZVNvcnRlZEhlbHBDb25maWciLCJzb3J0U3ViY29tbWFuZHMiLCJzb3J0T3B0aW9ucyIsImdldE9wdGlvblNvcnRLZXkiLCJvcHQiLCJsb25nIiwicmVwbGFjZSIsInNob3J0IiwiT2JqZWN0IiwiYXNzaWduIiwiY29uc3QiLCJjb21wYXJlT3B0aW9ucyIsImIiLCJsb2NhbGVDb21wYXJlIiwicHJvZ3JhbSIsImNvbmZpZ3VyZUhlbHAiLCJlbmFibGVQb3NpdGlvbmFsT3B0aW9ucyIsImhvb2siLCJ0aGlzQ29tbWFuZCIsIkNMQVVERV9DT0RFX0RJU0FCTEVfVEVSTUlOQUxfVElUTEUiLCJ0aXRsZSIsImluaXRTaW5rcyIsInBsdWdpbkRpciIsImdldE9wdGlvblZhbHVlIiwiQXJyYXkiLCJpc0FycmF5IiwiZXZlcnkiLCJwIiwidXBsb2FkVXNlclNldHRpbmdzSW5CYWNrZ3JvdW5kIiwibmFtZSIsImRlc2NyaXB0aW9uIiwiYXJndW1lbnQiLCJTdHJpbmciLCJoZWxwT3B0aW9uIiwib3B0aW9uIiwiX3ZhbHVlIiwiYWRkT3B0aW9uIiwiYXJnUGFyc2VyIiwiaGlkZUhlbHAiLCJjaG9pY2VzIiwiTnVtYmVyIiwidmFsdWUiLCJhbW91bnQiLCJpc05hTiIsInRva2VucyIsImlzSW50ZWdlciIsImRlZmF1bHQiLCJ2IiwibiIsImlzRmluaXRlIiwicmF3VmFsdWUiLCJ0b0xvd2VyQ2FzZSIsImFsbG93ZWQiLCJhY3Rpb24iLCJvcHRpb25zIiwiYmFyZSIsIkNMQVVERV9DT0RFX1NJTVBMRSIsImNvbnNvbGUiLCJ3YXJuIiwieWVsbG93Iiwia2Fpcm9zRW5hYmxlZCIsImFzc2lzdGFudFRlYW1Db250ZXh0IiwiQXdhaXRlZCIsIlJldHVyblR5cGUiLCJOb25OdWxsYWJsZSIsImFzc2lzdGFudCIsIm1hcmtBc3Npc3RhbnRGb3JjZWQiLCJpc0Fzc2lzdGFudE1vZGUiLCJhZ2VudElkIiwiaXNBc3Npc3RhbnRGb3JjZWQiLCJpc0thaXJvc0VuYWJsZWQiLCJicmllZiIsImluaXRpYWxpemVBc3Npc3RhbnRUZWFtIiwiZGVidWciLCJkZWJ1Z1RvU3RkZXJyIiwiYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyIsInRvb2xzIiwiYmFzZVRvb2xzIiwiYWxsb3dlZFRvb2xzIiwiZGlzYWxsb3dlZFRvb2xzIiwibWNwQ29uZmlnIiwicGVybWlzc2lvbk1vZGVDbGkiLCJhZGREaXIiLCJmYWxsYmFja01vZGVsIiwiYmV0YXMiLCJpZGUiLCJpbmNsdWRlSG9va0V2ZW50cyIsImluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMiLCJwcmVmaWxsIiwiZmlsZURvd25sb2FkUHJvbWlzZSIsImFnZW50c0pzb24iLCJhZ2VudHMiLCJhZ2VudENsaSIsImFnZW50IiwiQ0xBVURFX0NPREVfQUdFTlQiLCJvdXRwdXRGb3JtYXQiLCJ2ZXJib3NlIiwicHJpbnQiLCJpbml0T25seSIsIm1haW50ZW5hbmNlIiwiZGlzYWJsZVNsYXNoQ29tbWFuZHMiLCJ0YXNrc09wdGlvbiIsInRhc2tzIiwidGFza0xpc3RJZCIsIkNMQVVERV9DT0RFX1RBU0tfTElTVF9JRCIsIndvcmt0cmVlT3B0aW9uIiwid29ya3RyZWUiLCJ3b3JrdHJlZU5hbWUiLCJ3b3JrdHJlZUVuYWJsZWQiLCJ3b3JrdHJlZVBSTnVtYmVyIiwicHJOdW0iLCJ0bXV4RW5hYmxlZCIsInRtdXgiLCJzdG9yZWRUZWFtbWF0ZU9wdHMiLCJUZWFtbWF0ZU9wdGlvbnMiLCJ0ZWFtbWF0ZU9wdHMiLCJleHRyYWN0VGVhbW1hdGVPcHRpb25zIiwiaGFzQW55VGVhbW1hdGVPcHQiLCJhZ2VudE5hbWUiLCJ0ZWFtTmFtZSIsImhhc0FsbFJlcXVpcmVkVGVhbW1hdGVPcHRzIiwic2V0RHluYW1pY1RlYW1Db250ZXh0IiwiY29sb3IiLCJhZ2VudENvbG9yIiwicGxhbk1vZGVSZXF1aXJlZCIsInBhcmVudFNlc3Npb25JZCIsInRlYW1tYXRlTW9kZSIsInNldENsaVRlYW1tYXRlTW9kZU92ZXJyaWRlIiwic2RrVXJsIiwiZWZmZWN0aXZlSW5jbHVkZVBhcnRpYWxNZXNzYWdlcyIsIkNMQVVERV9DT0RFX0lOQ0xVREVfUEFSVElBTF9NRVNTQUdFUyIsIkNMQVVERV9DT0RFX1JFTU9URSIsInRlbGVwb3J0IiwicmVtb3RlT3B0aW9uIiwicmVtb3RlIiwicmVtb3RlQ29udHJvbE9wdGlvbiIsInJlbW90ZUNvbnRyb2wiLCJyYyIsInJlbW90ZUNvbnRyb2xOYW1lIiwiY29udGludWUiLCJyZXN1bWUiLCJmb3JrU2Vzc2lvbiIsInZhbGlkYXRlZFNlc3Npb25JZCIsImZpbGVTcGVjcyIsImZpbGUiLCJzZXNzaW9uVG9rZW4iLCJmaWxlU2Vzc2lvbklkIiwiQ0xBVURFX0NPREVfUkVNT1RFX1NFU1NJT05fSUQiLCJmaWxlcyIsImNvbmZpZyIsImJhc2VVcmwiLCJBTlRIUk9QSUNfQkFTRV9VUkwiLCJCQVNFX0FQSV9VUkwiLCJvYXV0aFRva2VuIiwic3lzdGVtUHJvbXB0Iiwic3lzdGVtUHJvbXB0RmlsZSIsImZpbGVQYXRoIiwiY29kZSIsImFwcGVuZFN5c3RlbVByb21wdCIsImFwcGVuZFN5c3RlbVByb21wdEZpbGUiLCJhZGRlbmR1bSIsIlRFQU1NQVRFX1NZU1RFTV9QUk9NUFRfQURERU5EVU0iLCJtb2RlIiwibm90aWZpY2F0aW9uIiwicGVybWlzc2lvbk1vZGVOb3RpZmljYXRpb24iLCJlbmFibGVBdXRvTW9kZSIsInNldEF1dG9Nb2RlRmxhZ0NsaSIsImR5bmFtaWNNY3BDb25maWciLCJwcm9jZXNzZWRDb25maWdzIiwibWFwIiwiYWxsQ29uZmlncyIsImFsbEVycm9ycyIsImNvbmZpZ0l0ZW0iLCJjb25maWdzIiwiY29uZmlnT2JqZWN0IiwiZXhwYW5kVmFycyIsInNjb3BlIiwibWNwU2VydmVycyIsImNvbmZpZ1BhdGgiLCJmb3JtYXR0ZWRFcnJvcnMiLCJwYXRoIiwibWVzc2FnZSIsImxldmVsIiwibm9uU2RrQ29uZmlnTmFtZXMiLCJlbnRyaWVzIiwidHlwZSIsInJlc2VydmVkTmFtZUVycm9yIiwiaXNDb21wdXRlclVzZU1DUFNlcnZlciIsIkNPTVBVVEVSX1VTRV9NQ1BfU0VSVkVSX05BTUUiLCJzY29wZWRDb25maWdzIiwiYmxvY2tlZCIsImNocm9tZU9wdHMiLCJjaHJvbWUiLCJlbmFibGVDbGF1ZGVJbkNocm9tZSIsImF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSIsImNocm9tZU1jcENvbmZpZyIsImNocm9tZU1jcFRvb2xzIiwiY2hyb21lU3lzdGVtUHJvbXB0IiwiaGludCIsIkJ1biIsInN0cmljdE1jcENvbmZpZyIsImdldENoaWNhZ29FbmFibGVkIiwic2V0dXBDb21wdXRlclVzZU1DUCIsImN1VG9vbHMiLCJkZXZDaGFubmVscyIsInBhcnNlQ2hhbm5lbEVudHJpZXMiLCJyYXciLCJiYWQiLCJjIiwiYXQiLCJraW5kIiwibWFya2V0cGxhY2UiLCJjaGFubmVsT3B0cyIsImNoYW5uZWxzIiwiZGFuZ2Vyb3VzbHlMb2FkRGV2ZWxvcG1lbnRDaGFubmVscyIsInJhd0NoYW5uZWxzIiwicmF3RGV2IiwiY2hhbm5lbEVudHJpZXMiLCJqb2luUGx1Z2luSWRzIiwiaWRzIiwiZmxhdE1hcCIsInNvcnQiLCJjaGFubmVsc19jb3VudCIsImRldl9jb3VudCIsInBsdWdpbnMiLCJkZXZfcGx1Z2lucyIsIkJSSUVGX1RPT0xfTkFNRSIsIkxFR0FDWV9CUklFRl9UT09MX05BTUUiLCJpc0JyaWVmRW50aXRsZWQiLCJpbml0UmVzdWx0IiwiYWxsb3dlZFRvb2xzQ2xpIiwiZGlzYWxsb3dlZFRvb2xzQ2xpIiwiYmFzZVRvb2xzQ2xpIiwiYWRkRGlycyIsInRvb2xQZXJtaXNzaW9uQ29udGV4dCIsIndhcm5pbmdzIiwiZGFuZ2Vyb3VzUGVybWlzc2lvbnMiLCJvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucyIsInBlcm1pc3Npb24iLCJydWxlRGlzcGxheSIsInNvdXJjZURpc3BsYXkiLCJmb3JFYWNoIiwid2FybmluZyIsImNsYXVkZWFpQ29uZmlnUHJvbWlzZSIsIm1jcENvbmZpZ1N0YXJ0IiwiRGF0ZSIsIm5vdyIsIm1jcENvbmZpZ1Jlc29sdmVkTXMiLCJtY3BDb25maWdQcm9taXNlIiwic2VydmVycyIsInJlcGxheVVzZXJNZXNzYWdlcyIsInNlc3Npb25QZXJzaXN0ZW5jZSIsImVmZmVjdGl2ZVByb21wdCIsImlucHV0UHJvbXB0IiwibWF5YmVBY3RpdmF0ZVByb2FjdGl2ZSIsIkNMQVVERV9DT0RFX0NPT1JESU5BVE9SX01PREUiLCJhcHBseUNvb3JkaW5hdG9yVG9vbEZpbHRlciIsImpzb25TY2hlbWEiLCJzeW50aGV0aWNPdXRwdXRSZXN1bHQiLCJ0b29sIiwic2NoZW1hX3Byb3BlcnR5X2NvdW50IiwicHJvcGVydGllcyIsImhhc19yZXF1aXJlZF9maWVsZHMiLCJyZXF1aXJlZCIsInNldHVwU3RhcnQiLCJzZXR1cCIsIm1lc3NhZ2luZ1NvY2tldFBhdGgiLCJwcmVTZXR1cEN3ZCIsInNldHVwUHJvbWlzZSIsImNvbW1hbmRzUHJvbWlzZSIsImFnZW50RGVmc1Byb21pc2UiLCJlZmZlY3RpdmVSZXBsYXlVc2VyTWVzc2FnZXMiLCJzZXNzaW9uTmFtZUFyZyIsImV4cGxpY2l0TW9kZWwiLCJBTlRIUk9QSUNfTU9ERUwiLCJjYWNoZWRHcm93dGhCb29rRmVhdHVyZXMiLCJ1c2VyU3BlY2lmaWVkTW9kZWwiLCJ1c2VyU3BlY2lmaWVkRmFsbGJhY2tNb2RlbCIsImN1cnJlbnRDd2QiLCJjb21tYW5kc1N0YXJ0IiwiY29tbWFuZHMiLCJhZ2VudERlZmluaXRpb25zUmVzdWx0IiwiY2xpQWdlbnRzIiwiYWN0aXZlQWdlbnRzIiwicGFyc2VkQWdlbnRzIiwiYWxsQWdlbnRzIiwiYWdlbnREZWZpbml0aW9ucyIsImFnZW50U2V0dGluZyIsIm1haW5UaHJlYWRBZ2VudERlZmluaXRpb24iLCJmaW5kIiwiYWdlbnRUeXBlIiwic291cmNlIiwiYWdlbnRTeXN0ZW1Qcm9tcHQiLCJnZXRTeXN0ZW1Qcm9tcHQiLCJpbml0aWFsUHJvbXB0IiwiZWZmZWN0aXZlTW9kZWwiLCJpbml0aWFsTWFpbkxvb3BNb2RlbCIsInJlc29sdmVkSW5pdGlhbE1vZGVsIiwiYWR2aXNvck1vZGVsIiwiYWR2aXNvck9wdGlvbiIsImFkdmlzb3IiLCJub3JtYWxpemVkQWR2aXNvck1vZGVsIiwiY3VzdG9tQWdlbnQiLCJjdXN0b21Qcm9tcHQiLCJtZW1vcnkiLCJhZ2VudF90eXBlIiwiY3VzdG9tSW5zdHJ1Y3Rpb25zIiwibWF5YmVBY3RpdmF0ZUJyaWVmIiwiZGVmYXVsdFZpZXciLCJwcm9hY3RpdmUiLCJDTEFVREVfQ09ERV9QUk9BQ1RJVkUiLCJpc0Nvb3JkaW5hdG9yTW9kZSIsImJyaWVmVmlzaWJpbGl0eSIsImlzQnJpZWZFbmFibGVkIiwicHJvYWN0aXZlUHJvbXB0IiwiYXNzaXN0YW50QWRkZW5kdW0iLCJnZXRBc3Npc3RhbnRTeXN0ZW1Qcm9tcHRBZGRlbmR1bSIsInJvb3QiLCJnZXRGcHNNZXRyaWNzIiwic3RhdHMiLCJjdHgiLCJjcmVhdGVSb290IiwicmVuZGVyT3B0aW9ucyIsImV2ZW50IiwiZHVyYXRpb25NcyIsIk1hdGgiLCJyb3VuZCIsInVwdGltZSIsInNldHVwU2NyZWVuc1N0YXJ0Iiwib25ib2FyZGluZ1Nob3duIiwiZ2V0QnJpZGdlRGlzYWJsZWRSZWFzb24iLCJkaXNhYmxlZFJlYXNvbiIsInBlbmRpbmdTbmFwc2hvdFVwZGF0ZSIsImFnZW50RGVmIiwiY2hvaWNlIiwic25hcHNob3RUaW1lc3RhbXAiLCJidWlsZE1lcmdlUHJvbXB0IiwibWVyZ2VQcm9tcHQiLCJjbGVhclRydXN0ZWREZXZpY2VUb2tlbiIsImVucm9sbFRydXN0ZWREZXZpY2UiLCJvcmdWYWxpZGF0aW9uIiwidmFsaWQiLCJub25NY3BFcnJvcnMiLCJtY3BFcnJvck1ldGFkYXRhIiwic2V0dGluZ3NFcnJvcnMiLCJvbkV4aXQiLCJiZ1JlZnJlc2hUaHJvdHRsZU1zIiwibGFzdFByZWZldGNoZWQiLCJzdGFydHVwUHJlZmV0Y2hlZEF0Iiwic2tpcFN0YXJ0dXBQcmVmZXRjaGVzIiwibGFzdFByZWZldGNoZWRJbmZvIiwiY3VycmVudCIsImV4aXN0aW5nTWNwQ29uZmlncyIsImFsbE1jcENvbmZpZ3MiLCJzZGtNY3BDb25maWdzIiwicmVndWxhck1jcENvbmZpZ3MiLCJ0eXBlZENvbmZpZyIsImxvY2FsTWNwUHJvbWlzZSIsImNsaWVudHMiLCJjbGF1ZGVhaU1jcFByb21pc2UiLCJtY3BQcm9taXNlIiwiY2xhdWRlYWkiLCJob29rc1Byb21pc2UiLCJob29rTWVzc2FnZXMiLCJtY3BDbGllbnRzIiwibWNwVG9vbHMiLCJtY3BDb21tYW5kcyIsInRoaW5raW5nRW5hYmxlZCIsInRoaW5raW5nQ29uZmlnIiwidGhpbmtpbmciLCJtYXhUaGlua2luZ1Rva2VucyIsIk1BWF9USElOS0lOR19UT0tFTlMiLCJwYXJzZUludCIsImJ1ZGdldFRva2VucyIsInZlcnNpb24iLCJNQUNSTyIsIlZFUlNJT04iLCJpc19uYXRpdmVfYmluYXJ5IiwibG9nVGVuZ3VJbml0IiwiaGFzSW5pdGlhbFByb21wdCIsImhhc1N0ZGluIiwibnVtQWxsb3dlZFRvb2xzIiwibnVtRGlzYWxsb3dlZFRvb2xzIiwibWNwQ2xpZW50Q291bnQiLCJza2lwV2ViRmV0Y2hQcmVmbGlnaHQiLCJnaXRodWJBY3Rpb25JbnB1dHMiLCJHSVRIVUJfQUNUSU9OX0lOUFVUUyIsImRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkIiwibW9kZUlzQnlwYXNzIiwiYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCIsInN5c3RlbVByb21wdEZsYWciLCJhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnIiwiYXNzaXN0YW50QWN0aXZhdGlvblBhdGgiLCJnZXRBc3Npc3RhbnRBY3RpdmF0aW9uUGF0aCIsInJlZ2lzdGVyZWQiLCJudW1fc2Vzc2lvbnMiLCJzZXR1cFRyaWdnZXIiLCJmb3JjZVN5bmNFeGVjdXRpb24iLCJzZXNzaW9uU3RhcnRIb29rc1Byb21pc2UiLCJjb21tYW5kc0hlYWRsZXNzIiwiY29tbWFuZCIsImRpc2FibGVOb25JbnRlcmFjdGl2ZSIsInN1cHBvcnRzTm9uSW50ZXJhY3RpdmUiLCJkZWZhdWx0U3RhdGUiLCJoZWFkbGVzc0luaXRpYWxTdGF0ZSIsIm1jcCIsImVmZm9ydFZhbHVlIiwiZWZmb3J0IiwiZmFzdE1vZGUiLCJoZWFkbGVzc1N0b3JlIiwiZ2V0U3RhdGUiLCJ1cGRhdGVDb250ZXh0Iiwic2V0U3RhdGUiLCJuZXh0Q3R4IiwiY29ubmVjdE1jcEJhdGNoIiwibGFiZWwiLCJjbGllbnQiLCJDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMiLCJjbGF1ZGVhaUNvbm5lY3QiLCJjbGF1ZGVhaUNvbmZpZ3MiLCJjbGF1ZGVhaVNpZ3MiLCJTZXQiLCJ2YWx1ZXMiLCJzaWciLCJhZGQiLCJzdXBwcmVzc2VkIiwiaGFzIiwic2l6ZSIsIm9uY2xvc2UiLCJyZXNvdXJjZXMiLCJ0IiwibWNwSW5mbyIsInNlcnZlck5hbWUiLCJub25QbHVnaW5Db25maWdzIiwiZGVkdXBlZENsYXVkZUFpIiwiY2xhdWRlYWlUaW1lciIsInNldFRpbWVvdXQiLCJjbGF1ZGVhaVRpbWVkT3V0IiwicmFjZSIsInIiLCJjbGVhclRpbWVvdXQiLCJzdGFydEJhY2tncm91bmRIb3VzZWtlZXBpbmciLCJzdGFydFNka01lbW9yeU1vbml0b3IiLCJydW5IZWFkbGVzcyIsInBlcm1pc3Npb25Qcm9tcHRUb29sTmFtZSIsInBlcm1pc3Npb25Qcm9tcHRUb29sIiwibWF4VHVybnMiLCJtYXhCdWRnZXRVc2QiLCJ0YXNrQnVkZ2V0IiwidG90YWwiLCJyZXN1bWVTZXNzaW9uQXQiLCJyZXdpbmRGaWxlcyIsImVuYWJsZUF1dGhTdGF0dXMiLCJ3b3JrbG9hZCIsImNsaV9mbGFnIiwiZW52X3ZhciIsInNldHRpbmdzX2ZpbGUiLCJzdWJzY3JpcHRpb25UeXBlIiwiZGVwcmVjYXRpb25XYXJuaW5nIiwiaW5pdGlhbE5vdGlmaWNhdGlvbnMiLCJrZXkiLCJ0ZXh0IiwicHJpb3JpdHkiLCJkaXNwbGF5TGlzdCIsImRpc3BsYXlzIiwiZWZmZWN0aXZlVG9vbFBlcm1pc3Npb25Db250ZXh0IiwiaXNQbGFuTW9kZVJlcXVpcmVkIiwiaW5pdGlhbElzQnJpZWZPbmx5IiwiZnVsbFJlbW90ZUNvbnRyb2wiLCJjY3JNaXJyb3JFbmFibGVkIiwiaXNDY3JNaXJyb3JFbmFibGVkIiwiaW5pdGlhbFN0YXRlIiwic2V0dGluZ3MiLCJhZ2VudE5hbWVSZWdpc3RyeSIsIk1hcCIsIm1haW5Mb29wTW9kZWwiLCJtYWluTG9vcE1vZGVsRm9yU2Vzc2lvbiIsImlzQnJpZWZPbmx5IiwiZXhwYW5kZWRWaWV3Iiwic2hvd1NwaW5uZXJUcmVlIiwic2hvd0V4cGFuZGVkVG9kb3MiLCJzaG93VGVhbW1hdGVNZXNzYWdlUHJldmlldyIsInNlbGVjdGVkSVBBZ2VudEluZGV4IiwiY29vcmRpbmF0b3JUYXNrSW5kZXgiLCJ2aWV3U2VsZWN0aW9uTW9kZSIsImZvb3RlclNlbGVjdGlvbiIsInBsdWdpblJlY29ubmVjdEtleSIsImRpc2FibGVkIiwiaW5zdGFsbGF0aW9uU3RhdHVzIiwibWFya2V0cGxhY2VzIiwibmVlZHNSZWZyZXNoIiwic3RhdHVzTGluZVRleHQiLCJyZW1vdGVTZXNzaW9uVXJsIiwicmVtb3RlQ29ubmVjdGlvblN0YXR1cyIsInJlbW90ZUJhY2tncm91bmRUYXNrQ291bnQiLCJyZXBsQnJpZGdlRW5hYmxlZCIsInJlcGxCcmlkZ2VFeHBsaWNpdCIsInJlcGxCcmlkZ2VPdXRib3VuZE9ubHkiLCJyZXBsQnJpZGdlQ29ubmVjdGVkIiwicmVwbEJyaWRnZVNlc3Npb25BY3RpdmUiLCJyZXBsQnJpZGdlUmVjb25uZWN0aW5nIiwicmVwbEJyaWRnZUNvbm5lY3RVcmwiLCJyZXBsQnJpZGdlU2Vzc2lvblVybCIsInJlcGxCcmlkZ2VFbnZpcm9ubWVudElkIiwicmVwbEJyaWRnZVNlc3Npb25JZCIsInJlcGxCcmlkZ2VFcnJvciIsInJlcGxCcmlkZ2VJbml0aWFsTmFtZSIsInNob3dSZW1vdGVDYWxsb3V0Iiwibm90aWZpY2F0aW9ucyIsInF1ZXVlIiwiZWxpY2l0YXRpb24iLCJ0b2RvcyIsInJlbW90ZUFnZW50VGFza1N1Z2dlc3Rpb25zIiwiZmlsZUhpc3RvcnkiLCJzbmFwc2hvdHMiLCJ0cmFja2VkRmlsZXMiLCJzbmFwc2hvdFNlcXVlbmNlIiwiYXR0cmlidXRpb24iLCJwcm9tcHRTdWdnZXN0aW9uRW5hYmxlZCIsInNlc3Npb25Ib29rcyIsImluYm94IiwibWVzc2FnZXMiLCJwcm9tcHRTdWdnZXN0aW9uIiwicHJvbXB0SWQiLCJzaG93bkF0IiwiYWNjZXB0ZWRBdCIsImdlbmVyYXRpb25SZXF1ZXN0SWQiLCJzcGVjdWxhdGlvbiIsInNwZWN1bGF0aW9uU2Vzc2lvblRpbWVTYXZlZE1zIiwic2tpbGxJbXByb3ZlbWVudCIsInN1Z2dlc3Rpb24iLCJ3b3JrZXJTYW5kYm94UGVybWlzc2lvbnMiLCJzZWxlY3RlZEluZGV4IiwicGVuZGluZ1dvcmtlclJlcXVlc3QiLCJwZW5kaW5nU2FuZGJveFJlcXVlc3QiLCJhdXRoVmVyc2lvbiIsImluaXRpYWxNZXNzYWdlIiwiY29udGVudCIsImFjdGl2ZU92ZXJsYXlzIiwidGVhbUNvbnRleHQiLCJpbml0aWFsVG9vbHMiLCJudW1TdGFydHVwcyIsInNldEltbWVkaWF0ZSIsInNlc3Npb25VcGxvYWRlclByb21pc2UiLCJ1cGxvYWRlclJlYWR5IiwibW9kIiwiY3JlYXRlU2Vzc2lvblR1cm5VcGxvYWRlciIsInNlc3Npb25Db25maWciLCJhdXRvQ29ubmVjdElkZUZsYWciLCJvblR1cm5Db21wbGV0ZSIsInVwbG9hZGVyIiwicmVzdW1lQ29udGV4dCIsIm1vZGVBcGkiLCJyZXN1bWVTdWNjZWVkZWQiLCJyZXN1bWVTdGFydCIsInBlcmZvcm1hbmNlIiwiY2xlYXJTZXNzaW9uQ2FjaGVzIiwic3VjY2VzcyIsImxvYWRlZCIsImluY2x1ZGVBdHRyaWJ1dGlvbiIsInRyYW5zY3JpcHRQYXRoIiwiZnVsbFBhdGgiLCJyZXN0b3JlZEFnZW50RGVmIiwicmVzdW1lX2R1cmF0aW9uX21zIiwiaW5pdGlhbE1lc3NhZ2VzIiwiaW5pdGlhbEZpbGVIaXN0b3J5U25hcHNob3RzIiwiZmlsZUhpc3RvcnlTbmFwc2hvdHMiLCJpbml0aWFsQ29udGVudFJlcGxhY2VtZW50cyIsImNvbnRlbnRSZXBsYWNlbWVudHMiLCJpbml0aWFsQWdlbnROYW1lIiwiaW5pdGlhbEFnZW50Q29sb3IiLCJkaXJlY3RDb25uZWN0Q29uZmlnIiwic2Vzc2lvbiIsIndvcmtEaXIiLCJjb25uZWN0SW5mb01lc3NhZ2UiLCJjcmVhdGVTU0hTZXNzaW9uIiwiY3JlYXRlTG9jYWxTU0hTZXNzaW9uIiwiU1NIU2Vzc2lvbkVycm9yIiwic3NoU2Vzc2lvbiIsImhhZFByb2dyZXNzIiwibG9jYWxWZXJzaW9uIiwib25Qcm9ncmVzcyIsIm1zZyIsInJlbW90ZUN3ZCIsInNzaEluZm9NZXNzYWdlIiwiZGlzY292ZXJBc3Npc3RhbnRTZXNzaW9ucyIsInRhcmdldFNlc3Npb25JZCIsInNlc3Npb25zIiwiaW5zdGFsbGVkRGlyIiwiYmVmb3JlRXhpdCIsImlkIiwicGlja2VkIiwiY2hlY2tBbmRSZWZyZXNoT0F1dGhUb2tlbklmTmVlZGVkIiwiZ2V0Q2xhdWRlQUlPQXV0aFRva2VucyIsImFwaUNyZWRzIiwiZ2V0QWNjZXNzVG9rZW4iLCJhY2Nlc3NUb2tlbiIsInJlbW90ZVNlc3Npb25Db25maWciLCJvcmdVVUlEIiwiaW5mb01lc3NhZ2UiLCJhc3Npc3RhbnRJbml0aWFsU3RhdGUiLCJyZW1vdGVDb21tYW5kcyIsImZyb21QciIsInByb2Nlc3NlZFJlc3VtZSIsIm1heWJlU2Vzc2lvbklkIiwic2VhcmNoVGVybSIsIm1hdGNoZWRMb2ciLCJmaWx0ZXJCeVByIiwidHJpbW1lZFZhbHVlIiwibWF0Y2hlcyIsImV4YWN0IiwiaXNSZW1vdGVUdWlFbmFibGVkIiwiaGFzX2luaXRpYWxfcHJvbXB0IiwiY3VycmVudEJyYW5jaCIsImNyZWF0ZWRTZXNzaW9uIiwiQWJvcnRDb250cm9sbGVyIiwic2lnbmFsIiwic2Vzc2lvbl9pZCIsImdldFRva2Vuc0ZvclJlbW90ZSIsImdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlIiwicmVtb3RlSW5mb01lc3NhZ2UiLCJpbml0aWFsVXNlck1lc3NhZ2UiLCJyZW1vdGVJbml0aWFsU3RhdGUiLCJ0ZWxlcG9ydFJlc3VsdCIsImJyYW5jaEVycm9yIiwiYnJhbmNoIiwibG9nIiwic2Vzc2lvbkRhdGEiLCJyZXBvVmFsaWRhdGlvbiIsInN0YXR1cyIsInNlc3Npb25SZXBvIiwia25vd25QYXRocyIsImV4aXN0aW5nUGF0aHMiLCJzZWxlY3RlZFBhdGgiLCJ0YXJnZXRSZXBvIiwiaW5pdGlhbFBhdGhzIiwiY2hkaXIiLCJib2xkIiwidGVsZXBvcnRXaXRoUHJvZ3Jlc3MiLCJmb3JtYXR0ZWRNZXNzYWdlIiwicGFyc2VDY3NoYXJlSWQiLCJsb2FkQ2NzaGFyZSIsImNjc2hhcmVJZCIsImxvZ09wdGlvbiIsImVudHJ5cG9pbnQiLCJzZXNzaW9uSWRPdmVycmlkZSIsInJlc3VsdHMiLCJmYWlsZWRDb3VudCIsInJlc3VtZURhdGEiLCJpbml0aWFsU2VhcmNoUXVlcnkiLCJwZW5kaW5nSG9va01lc3NhZ2VzIiwiZGVlcExpbmtCYW5uZXIiLCJkZWVwTGlua09yaWdpbiIsImhhc19wcmVmaWxsIiwiaGFzX3JlcG8iLCJkZWVwTGlua1JlcG8iLCJwcmVmaWxsTGVuZ3RoIiwicmVwbyIsImxhc3RGZXRjaCIsImRlZXBMaW5rTGFzdEZldGNoIiwiaW1wbGllcyIsImlzUHJpbnRNb2RlIiwiaXNDY1VybCIsInBhcnNlQXN5bmMiLCJtY3BTZXJ2ZUhhbmRsZXIiLCJtY3BSZW1vdmVIYW5kbGVyIiwibWNwTGlzdEhhbmRsZXIiLCJtY3BHZXRIYW5kbGVyIiwianNvbiIsImNsaWVudFNlY3JldCIsIm1jcEFkZEpzb25IYW5kbGVyIiwibWNwQWRkRnJvbURlc2t0b3BIYW5kbGVyIiwibWNwUmVzZXRDaG9pY2VzSGFuZGxlciIsInBvcnQiLCJ1bml4Iiwid29ya3NwYWNlIiwiaWRsZVRpbWVvdXQiLCJtYXhTZXNzaW9ucyIsInJhbmRvbUJ5dGVzIiwic3RhcnRTZXJ2ZXIiLCJTZXNzaW9uTWFuYWdlciIsIkRhbmdlcm91c0JhY2tlbmQiLCJwcmludEJhbm5lciIsImNyZWF0ZVNlcnZlckxvZ2dlciIsIndyaXRlU2VydmVyTG9jayIsInJlbW92ZVNlcnZlckxvY2siLCJwcm9iZVJ1bm5pbmdTZXJ2ZXIiLCJleGlzdGluZyIsInBpZCIsImh0dHBVcmwiLCJ0b1N0cmluZyIsImlkbGVUaW1lb3V0TXMiLCJiYWNrZW5kIiwic2Vzc2lvbk1hbmFnZXIiLCJsb2dnZXIiLCJzZXJ2ZXIiLCJhY3R1YWxQb3J0Iiwic3RhcnRlZEF0Iiwic2h1dHRpbmdEb3duIiwic2h1dGRvd24iLCJzdG9wIiwiZGVzdHJveUFsbCIsIm9uY2UiLCJjb25uZWN0Q29uZmlnIiwicnVuQ29ubmVjdEhlYWRsZXNzIiwiaW50ZXJhY3RpdmUiLCJhdXRoIiwiZW1haWwiLCJzc28iLCJ1c2VDb25zb2xlIiwiYXV0aExvZ2luIiwiYXV0aFN0YXR1cyIsImF1dGhMb2dvdXQiLCJjb3dvcmtPcHRpb24iLCJwbHVnaW5DbWQiLCJhbGlhcyIsIm1hbmlmZXN0UGF0aCIsImNvd29yayIsInBsdWdpblZhbGlkYXRlSGFuZGxlciIsImF2YWlsYWJsZSIsInBsdWdpbkxpc3RIYW5kbGVyIiwibWFya2V0cGxhY2VDbWQiLCJzcGFyc2UiLCJtYXJrZXRwbGFjZUFkZEhhbmRsZXIiLCJtYXJrZXRwbGFjZUxpc3RIYW5kbGVyIiwibWFya2V0cGxhY2VSZW1vdmVIYW5kbGVyIiwibWFya2V0cGxhY2VVcGRhdGVIYW5kbGVyIiwicGx1Z2luIiwicGx1Z2luSW5zdGFsbEhhbmRsZXIiLCJrZWVwRGF0YSIsInBsdWdpblVuaW5zdGFsbEhhbmRsZXIiLCJwbHVnaW5FbmFibGVIYW5kbGVyIiwicGx1Z2luRGlzYWJsZUhhbmRsZXIiLCJwbHVnaW5VcGRhdGVIYW5kbGVyIiwic2V0dXBUb2tlbkhhbmRsZXIiLCJhZ2VudHNIYW5kbGVyIiwiYXV0b01vZGVDbWQiLCJhdXRvTW9kZURlZmF1bHRzSGFuZGxlciIsImF1dG9Nb2RlQ29uZmlnSGFuZGxlciIsImF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyIiwiaGlkZGVuIiwiYnJpZGdlTWFpbiIsImRvY3RvckhhbmRsZXIiLCJ1cGRhdGUiLCJ1cCIsInRhcmdldCIsImxpc3QiLCJkcnlSdW4iLCJzYWZlIiwicm9sbGJhY2siLCJmb3JjZSIsImluc3RhbGxIYW5kbGVyIiwidmFsaWRhdGVMb2dJZCIsImxvZ0lkIiwibG9nSGFuZGxlciIsIm51bWJlciIsImVycm9ySGFuZGxlciIsInVzYWdlIiwiYWRkSGVscFRleHQiLCJvdXRwdXRGaWxlIiwiZXhwb3J0SGFuZGxlciIsInRhc2tDbWQiLCJzdWJqZWN0IiwidGFza0NyZWF0ZUhhbmRsZXIiLCJwZW5kaW5nIiwidGFza0xpc3RIYW5kbGVyIiwidGFza0dldEhhbmRsZXIiLCJvd25lciIsImNsZWFyT3duZXIiLCJ0YXNrVXBkYXRlSGFuZGxlciIsInRhc2tEaXJIYW5kbGVyIiwic2hlbGwiLCJvdXRwdXQiLCJjb21wbGV0aW9uSGFuZGxlciIsImluUHJvdGVjdGVkTmFtZXNwYWNlIiwidGhpbmtpbmdUeXBlIiwiaXNfc2ltcGxlIiwiaXNfY29vcmRpbmF0b3IiLCJhdXRvVXBkYXRlc0NoYW5uZWwiLCJnaXRSb290IiwicnAiLCJyZWxhdGl2ZVByb2plY3RQYXRoIiwicHJvYWN0aXZlTW9kdWxlIiwiaXNQcm9hY3RpdmVBY3RpdmUiLCJhY3RpdmF0ZVByb2FjdGl2ZSIsImJyaWVmRmxhZyIsImJyaWVmRW52IiwiQ0xBVURFX0NPREVfQlJJRUYiLCJlbnRpdGxlZCIsImdhdGVkIiwidGVybWluYWwiXSwic291cmNlcyI6WyJtYWluLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyIvLyBUaGVzZSBzaWRlLWVmZmVjdHMgbXVzdCBydW4gYmVmb3JlIGFsbCBvdGhlciBpbXBvcnRzOlxuLy8gMS4gcHJvZmlsZUNoZWNrcG9pbnQgbWFya3MgZW50cnkgYmVmb3JlIGhlYXZ5IG1vZHVsZSBldmFsdWF0aW9uIGJlZ2luc1xuLy8gMi4gc3RhcnRNZG1SYXdSZWFkIGZpcmVzIE1ETSBzdWJwcm9jZXNzZXMgKHBsdXRpbC9yZWcgcXVlcnkpIHNvIHRoZXkgcnVuIGluXG4vLyAgICBwYXJhbGxlbCB3aXRoIHRoZSByZW1haW5pbmcgfjEzNW1zIG9mIGltcG9ydHMgYmVsb3dcbi8vIDMuIHN0YXJ0S2V5Y2hhaW5QcmVmZXRjaCBmaXJlcyBib3RoIG1hY09TIGtleWNoYWluIHJlYWRzIChPQXV0aCArIGxlZ2FjeSBBUElcbi8vICAgIGtleSkgaW4gcGFyYWxsZWwgXHUyMDE0IGlzUmVtb3RlTWFuYWdlZFNldHRpbmdzRWxpZ2libGUoKSBvdGhlcndpc2UgcmVhZHMgdGhlbVxuLy8gICAgc2VxdWVudGlhbGx5IHZpYSBzeW5jIHNwYXduIGluc2lkZSBhcHBseVNhZmVDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcygpXG4vLyAgICAofjY1bXMgb24gZXZlcnkgbWFjT1Mgc3RhcnR1cClcbmltcG9ydCB7IHByb2ZpbGVDaGVja3BvaW50LCBwcm9maWxlUmVwb3J0IH0gZnJvbSAnLi91dGlscy9zdGFydHVwUHJvZmlsZXIuanMnXG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xucHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fdHN4X2VudHJ5JylcblxuaW1wb3J0IHsgc3RhcnRNZG1SYXdSZWFkIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9tZG0vcmF3UmVhZC5qcydcblxuLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIGN1c3RvbS1ydWxlcy9uby10b3AtbGV2ZWwtc2lkZS1lZmZlY3RzXG5zdGFydE1kbVJhd1JlYWQoKVxuXG5pbXBvcnQge1xuICBlbnN1cmVLZXljaGFpblByZWZldGNoQ29tcGxldGVkLFxuICBzdGFydEtleWNoYWluUHJlZmV0Y2gsXG59IGZyb20gJy4vdXRpbHMvc2VjdXJlU3RvcmFnZS9rZXljaGFpblByZWZldGNoLmpzJ1xuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgY3VzdG9tLXJ1bGVzL25vLXRvcC1sZXZlbC1zaWRlLWVmZmVjdHNcbnN0YXJ0S2V5Y2hhaW5QcmVmZXRjaCgpXG5cbmltcG9ydCB7IGZlYXR1cmUgfSBmcm9tICdidW46YnVuZGxlJ1xuaW1wb3J0IHtcbiAgQ29tbWFuZCBhcyBDb21tYW5kZXJDb21tYW5kLFxuICBJbnZhbGlkQXJndW1lbnRFcnJvcixcbiAgT3B0aW9uLFxufSBmcm9tICdAY29tbWFuZGVyLWpzL2V4dHJhLXR5cGluZ3MnXG5pbXBvcnQgY2hhbGsgZnJvbSAnY2hhbGsnXG5pbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcydcbmltcG9ydCBtYXBWYWx1ZXMgZnJvbSAnbG9kYXNoLWVzL21hcFZhbHVlcy5qcydcbmltcG9ydCBwaWNrQnkgZnJvbSAnbG9kYXNoLWVzL3BpY2tCeS5qcydcbmltcG9ydCB1bmlxQnkgZnJvbSAnbG9kYXNoLWVzL3VuaXFCeS5qcydcbmltcG9ydCBSZWFjdCBmcm9tICdyZWFjdCdcbmltcG9ydCB7IGdldE9hdXRoQ29uZmlnIH0gZnJvbSAnLi9jb25zdGFudHMvb2F1dGguanMnXG5pbXBvcnQgeyBnZXRSZW1vdGVTZXNzaW9uVXJsIH0gZnJvbSAnLi9jb25zdGFudHMvcHJvZHVjdC5qcydcbmltcG9ydCB7IGdldFN5c3RlbUNvbnRleHQsIGdldFVzZXJDb250ZXh0IH0gZnJvbSAnLi9jb250ZXh0LmpzJ1xuaW1wb3J0IHsgaW5pdCwgaW5pdGlhbGl6ZVRlbGVtZXRyeUFmdGVyVHJ1c3QgfSBmcm9tICcuL2VudHJ5cG9pbnRzL2luaXQuanMnXG5pbXBvcnQgeyBhZGRUb0hpc3RvcnkgfSBmcm9tICcuL2hpc3RvcnkuanMnXG5pbXBvcnQgdHlwZSB7IFJvb3QgfSBmcm9tICcuL2luay5qcydcbmltcG9ydCB7IGxhdW5jaFJlcGwgfSBmcm9tICcuL3JlcGxMYXVuY2hlci5qcydcbmltcG9ydCB7XG4gIGhhc0dyb3d0aEJvb2tFbnZPdmVycmlkZSxcbiAgaW5pdGlhbGl6ZUdyb3d0aEJvb2ssXG4gIHJlZnJlc2hHcm93dGhCb29rQWZ0ZXJBdXRoQ2hhbmdlLFxufSBmcm9tICcuL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHsgZmV0Y2hCb290c3RyYXBEYXRhIH0gZnJvbSAnLi9zZXJ2aWNlcy9hcGkvYm9vdHN0cmFwLmpzJ1xuaW1wb3J0IHtcbiAgdHlwZSBEb3dubG9hZFJlc3VsdCxcbiAgZG93bmxvYWRTZXNzaW9uRmlsZXMsXG4gIHR5cGUgRmlsZXNBcGlDb25maWcsXG4gIHBhcnNlRmlsZVNwZWNzLFxufSBmcm9tICcuL3NlcnZpY2VzL2FwaS9maWxlc0FwaS5qcydcbmltcG9ydCB7IHByZWZldGNoUGFzc2VzRWxpZ2liaWxpdHkgfSBmcm9tICcuL3NlcnZpY2VzL2FwaS9yZWZlcnJhbC5qcydcbmltcG9ydCB7IHByZWZldGNoT2ZmaWNpYWxNY3BVcmxzIH0gZnJvbSAnLi9zZXJ2aWNlcy9tY3Avb2ZmaWNpYWxSZWdpc3RyeS5qcydcbmltcG9ydCB0eXBlIHtcbiAgTWNwU2RrU2VydmVyQ29uZmlnLFxuICBNY3BTZXJ2ZXJDb25maWcsXG4gIFNjb3BlZE1jcFNlcnZlckNvbmZpZyxcbn0gZnJvbSAnLi9zZXJ2aWNlcy9tY3AvdHlwZXMuanMnXG5pbXBvcnQge1xuICBpc1BvbGljeUFsbG93ZWQsXG4gIGxvYWRQb2xpY3lMaW1pdHMsXG4gIHJlZnJlc2hQb2xpY3lMaW1pdHMsXG4gIHdhaXRGb3JQb2xpY3lMaW1pdHNUb0xvYWQsXG59IGZyb20gJy4vc2VydmljZXMvcG9saWN5TGltaXRzL2luZGV4LmpzJ1xuaW1wb3J0IHtcbiAgbG9hZFJlbW90ZU1hbmFnZWRTZXR0aW5ncyxcbiAgcmVmcmVzaFJlbW90ZU1hbmFnZWRTZXR0aW5ncyxcbn0gZnJvbSAnLi9zZXJ2aWNlcy9yZW1vdGVNYW5hZ2VkU2V0dGluZ3MvaW5kZXguanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xJbnB1dEpTT05TY2hlbWEgfSBmcm9tICcuL1Rvb2wuanMnXG5pbXBvcnQge1xuICBjcmVhdGVTeW50aGV0aWNPdXRwdXRUb29sLFxuICBpc1N5bnRoZXRpY091dHB1dFRvb2xFbmFibGVkLFxufSBmcm9tICcuL3Rvb2xzL1N5bnRoZXRpY091dHB1dFRvb2wvU3ludGhldGljT3V0cHV0VG9vbC5qcydcbmltcG9ydCB7IGdldFRvb2xzIH0gZnJvbSAnLi90b29scy5qcydcbmltcG9ydCB7XG4gIGNhblVzZXJDb25maWd1cmVBZHZpc29yLFxuICBnZXRJbml0aWFsQWR2aXNvclNldHRpbmcsXG4gIGlzQWR2aXNvckVuYWJsZWQsXG4gIGlzVmFsaWRBZHZpc29yTW9kZWwsXG4gIG1vZGVsU3VwcG9ydHNBZHZpc29yLFxufSBmcm9tICcuL3V0aWxzL2Fkdmlzb3IuanMnXG5pbXBvcnQgeyBpc0FnZW50U3dhcm1zRW5hYmxlZCB9IGZyb20gJy4vdXRpbHMvYWdlbnRTd2FybXNFbmFibGVkLmpzJ1xuaW1wb3J0IHsgY291bnQsIHVuaXEgfSBmcm9tICcuL3V0aWxzL2FycmF5LmpzJ1xuaW1wb3J0IHsgaW5zdGFsbEFzY2lpY2FzdFJlY29yZGVyIH0gZnJvbSAnLi91dGlscy9hc2NpaWNhc3QuanMnXG5pbXBvcnQge1xuICBnZXRTdWJzY3JpcHRpb25UeXBlLFxuICBpc0NsYXVkZUFJU3Vic2NyaWJlcixcbiAgcHJlZmV0Y2hBd3NDcmVkZW50aWFsc0FuZEJlZFJvY2tJbmZvSWZTYWZlLFxuICBwcmVmZXRjaEdjcENyZWRlbnRpYWxzSWZTYWZlLFxuICB2YWxpZGF0ZUZvcmNlTG9naW5PcmcsXG59IGZyb20gJy4vdXRpbHMvYXV0aC5qcydcbmltcG9ydCB7XG4gIGNoZWNrSGFzVHJ1c3REaWFsb2dBY2NlcHRlZCxcbiAgZ2V0R2xvYmFsQ29uZmlnLFxuICBnZXRSZW1vdGVDb250cm9sQXRTdGFydHVwLFxuICBpc0F1dG9VcGRhdGVyRGlzYWJsZWQsXG4gIHNhdmVHbG9iYWxDb25maWcsXG59IGZyb20gJy4vdXRpbHMvY29uZmlnLmpzJ1xuaW1wb3J0IHsgc2VlZEVhcmx5SW5wdXQsIHN0b3BDYXB0dXJpbmdFYXJseUlucHV0IH0gZnJvbSAnLi91dGlscy9lYXJseUlucHV0LmpzJ1xuaW1wb3J0IHsgZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmcsIHBhcnNlRWZmb3J0VmFsdWUgfSBmcm9tICcuL3V0aWxzL2VmZm9ydC5qcydcbmltcG9ydCB7XG4gIGdldEluaXRpYWxGYXN0TW9kZVNldHRpbmcsXG4gIGlzRmFzdE1vZGVFbmFibGVkLFxuICBwcmVmZXRjaEZhc3RNb2RlU3RhdHVzLFxuICByZXNvbHZlRmFzdE1vZGVTdGF0dXNGcm9tQ2FjaGUsXG59IGZyb20gJy4vdXRpbHMvZmFzdE1vZGUuanMnXG5pbXBvcnQgeyBhcHBseUNvbmZpZ0Vudmlyb25tZW50VmFyaWFibGVzIH0gZnJvbSAnLi91dGlscy9tYW5hZ2VkRW52LmpzJ1xuaW1wb3J0IHsgY3JlYXRlU3lzdGVtTWVzc2FnZSwgY3JlYXRlVXNlck1lc3NhZ2UgfSBmcm9tICcuL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHsgZ2V0UGxhdGZvcm0gfSBmcm9tICcuL3V0aWxzL3BsYXRmb3JtLmpzJ1xuaW1wb3J0IHsgZ2V0QmFzZVJlbmRlck9wdGlvbnMgfSBmcm9tICcuL3V0aWxzL3JlbmRlck9wdGlvbnMuanMnXG5pbXBvcnQgeyBnZXRTZXNzaW9uSW5ncmVzc0F1dGhUb2tlbiB9IGZyb20gJy4vdXRpbHMvc2Vzc2lvbkluZ3Jlc3NBdXRoLmpzJ1xuaW1wb3J0IHsgc2V0dGluZ3NDaGFuZ2VEZXRlY3RvciB9IGZyb20gJy4vdXRpbHMvc2V0dGluZ3MvY2hhbmdlRGV0ZWN0b3IuanMnXG5pbXBvcnQgeyBza2lsbENoYW5nZURldGVjdG9yIH0gZnJvbSAnLi91dGlscy9za2lsbHMvc2tpbGxDaGFuZ2VEZXRlY3Rvci5qcydcbmltcG9ydCB7IGpzb25QYXJzZSwgd3JpdGVGaWxlU3luY19ERVBSRUNBVEVEIH0gZnJvbSAnLi91dGlscy9zbG93T3BlcmF0aW9ucy5qcydcbmltcG9ydCB7IGNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQgfSBmcm9tICcuL3V0aWxzL3N3YXJtL3JlY29ubmVjdGlvbi5qcydcbmltcG9ydCB7IGluaXRpYWxpemVXYXJuaW5nSGFuZGxlciB9IGZyb20gJy4vdXRpbHMvd2FybmluZ0hhbmRsZXIuanMnXG5pbXBvcnQgeyBpc1dvcmt0cmVlTW9kZUVuYWJsZWQgfSBmcm9tICcuL3V0aWxzL3dvcmt0cmVlTW9kZUVuYWJsZWQuanMnXG5cbi8vIExhenkgcmVxdWlyZSB0byBhdm9pZCBjaXJjdWxhciBkZXBlbmRlbmN5OiB0ZWFtbWF0ZS50cyAtPiBBcHBTdGF0ZS50c3ggLT4gLi4uIC0+IG1haW4udHN4XG4vKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG5jb25zdCBnZXRUZWFtbWF0ZVV0aWxzID0gKCkgPT5cbiAgcmVxdWlyZSgnLi91dGlscy90ZWFtbWF0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvdGVhbW1hdGUuanMnKVxuY29uc3QgZ2V0VGVhbW1hdGVQcm9tcHRBZGRlbmR1bSA9ICgpID0+XG4gIHJlcXVpcmUoJy4vdXRpbHMvc3dhcm0vdGVhbW1hdGVQcm9tcHRBZGRlbmR1bS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvc3dhcm0vdGVhbW1hdGVQcm9tcHRBZGRlbmR1bS5qcycpXG5jb25zdCBnZXRUZWFtbWF0ZU1vZGVTbmFwc2hvdCA9ICgpID0+XG4gIHJlcXVpcmUoJy4vdXRpbHMvc3dhcm0vYmFja2VuZHMvdGVhbW1hdGVNb2RlU25hcHNob3QuanMnKSBhcyB0eXBlb2YgaW1wb3J0KCcuL3V0aWxzL3N3YXJtL2JhY2tlbmRzL3RlYW1tYXRlTW9kZVNuYXBzaG90LmpzJylcbi8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuLy8gRGVhZCBjb2RlIGVsaW1pbmF0aW9uOiBjb25kaXRpb25hbCBpbXBvcnQgZm9yIENPT1JESU5BVE9SX01PREVcbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbmNvbnN0IGNvb3JkaW5hdG9yTW9kZU1vZHVsZSA9IGZlYXR1cmUoJ0NPT1JESU5BVE9SX01PREUnKVxuICA/IChyZXF1aXJlKCcuL2Nvb3JkaW5hdG9yL2Nvb3JkaW5hdG9yTW9kZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vY29vcmRpbmF0b3IvY29vcmRpbmF0b3JNb2RlLmpzJykpXG4gIDogbnVsbFxuLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4vLyBEZWFkIGNvZGUgZWxpbWluYXRpb246IGNvbmRpdGlvbmFsIGltcG9ydCBmb3IgS0FJUk9TIChhc3Npc3RhbnQgbW9kZSlcbi8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbmNvbnN0IGFzc2lzdGFudE1vZHVsZSA9IGZlYXR1cmUoJ0tBSVJPUycpXG4gID8gKHJlcXVpcmUoJy4vYXNzaXN0YW50L2luZGV4LmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi9hc3Npc3RhbnQvaW5kZXguanMnKSlcbiAgOiBudWxsXG5jb25zdCBrYWlyb3NHYXRlID0gZmVhdHVyZSgnS0FJUk9TJylcbiAgPyAocmVxdWlyZSgnLi9hc3Npc3RhbnQvZ2F0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vYXNzaXN0YW50L2dhdGUuanMnKSlcbiAgOiBudWxsXG5cbmltcG9ydCB7IHJlbGF0aXZlLCByZXNvbHZlIH0gZnJvbSAncGF0aCdcbmltcG9ydCB7IGlzQW5hbHl0aWNzRGlzYWJsZWQgfSBmcm9tICdzcmMvc2VydmljZXMvYW5hbHl0aWNzL2NvbmZpZy5qcydcbmltcG9ydCB7IGdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFIH0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHtcbiAgdHlwZSBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICBsb2dFdmVudCxcbn0gZnJvbSAnc3JjL3NlcnZpY2VzL2FuYWx5dGljcy9pbmRleC5qcydcbmltcG9ydCB7IGluaXRpYWxpemVBbmFseXRpY3NHYXRlcyB9IGZyb20gJ3NyYy9zZXJ2aWNlcy9hbmFseXRpY3Mvc2luay5qcydcbmltcG9ydCB7XG4gIGdldE9yaWdpbmFsQ3dkLFxuICBzZXRBZGRpdGlvbmFsRGlyZWN0b3JpZXNGb3JDbGF1ZGVNZCxcbiAgc2V0SXNSZW1vdGVNb2RlLFxuICBzZXRNYWluTG9vcE1vZGVsT3ZlcnJpZGUsXG4gIHNldE1haW5UaHJlYWRBZ2VudFR5cGUsXG4gIHNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyxcbn0gZnJvbSAnLi9ib290c3RyYXAvc3RhdGUuanMnXG5pbXBvcnQgeyBmaWx0ZXJDb21tYW5kc0ZvclJlbW90ZU1vZGUsIGdldENvbW1hbmRzIH0gZnJvbSAnLi9jb21tYW5kcy5qcydcbmltcG9ydCB0eXBlIHsgU3RhdHNTdG9yZSB9IGZyb20gJy4vY29udGV4dC9zdGF0cy5qcydcbmltcG9ydCB7XG4gIGxhdW5jaEFzc2lzdGFudEluc3RhbGxXaXphcmQsXG4gIGxhdW5jaEFzc2lzdGFudFNlc3Npb25DaG9vc2VyLFxuICBsYXVuY2hJbnZhbGlkU2V0dGluZ3NEaWFsb2csXG4gIGxhdW5jaFJlc3VtZUNob29zZXIsXG4gIGxhdW5jaFNuYXBzaG90VXBkYXRlRGlhbG9nLFxuICBsYXVuY2hUZWxlcG9ydFJlcG9NaXNtYXRjaERpYWxvZyxcbiAgbGF1bmNoVGVsZXBvcnRSZXN1bWVXcmFwcGVyLFxufSBmcm9tICcuL2RpYWxvZ0xhdW5jaGVycy5qcydcbmltcG9ydCB7IFNIT1dfQ1VSU09SIH0gZnJvbSAnLi9pbmsvdGVybWlvL2RlYy5qcydcbmltcG9ydCB7XG4gIGV4aXRXaXRoRXJyb3IsXG4gIGV4aXRXaXRoTWVzc2FnZSxcbiAgZ2V0UmVuZGVyQ29udGV4dCxcbiAgcmVuZGVyQW5kUnVuLFxuICBzaG93U2V0dXBTY3JlZW5zLFxufSBmcm9tICcuL2ludGVyYWN0aXZlSGVscGVycy5qcydcbmltcG9ydCB7IGluaXRCdWlsdGluUGx1Z2lucyB9IGZyb20gJy4vcGx1Z2lucy9idW5kbGVkL2luZGV4LmpzJ1xuLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG5pbXBvcnQgeyBjaGVja1F1b3RhU3RhdHVzIH0gZnJvbSAnLi9zZXJ2aWNlcy9jbGF1ZGVBaUxpbWl0cy5qcydcbmltcG9ydCB7XG4gIGdldE1jcFRvb2xzQ29tbWFuZHNBbmRSZXNvdXJjZXMsXG4gIHByZWZldGNoQWxsTWNwUmVzb3VyY2VzLFxufSBmcm9tICcuL3NlcnZpY2VzL21jcC9jbGllbnQuanMnXG5pbXBvcnQge1xuICBWQUxJRF9JTlNUQUxMQUJMRV9TQ09QRVMsXG4gIFZBTElEX1VQREFURV9TQ09QRVMsXG59IGZyb20gJy4vc2VydmljZXMvcGx1Z2lucy9wbHVnaW5DbGlDb21tYW5kcy5qcydcbmltcG9ydCB7IGluaXRCdW5kbGVkU2tpbGxzIH0gZnJvbSAnLi9za2lsbHMvYnVuZGxlZC9pbmRleC5qcydcbmltcG9ydCB0eXBlIHsgQWdlbnRDb2xvck5hbWUgfSBmcm9tICcuL3Rvb2xzL0FnZW50VG9vbC9hZ2VudENvbG9yTWFuYWdlci5qcydcbmltcG9ydCB7XG4gIGdldEFjdGl2ZUFnZW50c0Zyb21MaXN0LFxuICBnZXRBZ2VudERlZmluaXRpb25zV2l0aE92ZXJyaWRlcyxcbiAgaXNCdWlsdEluQWdlbnQsXG4gIGlzQ3VzdG9tQWdlbnQsXG4gIHBhcnNlQWdlbnRzRnJvbUpzb24sXG59IGZyb20gJy4vdG9vbHMvQWdlbnRUb29sL2xvYWRBZ2VudHNEaXIuanMnXG5pbXBvcnQgdHlwZSB7IExvZ09wdGlvbiB9IGZyb20gJy4vdHlwZXMvbG9ncy5qcydcbmltcG9ydCB0eXBlIHsgTWVzc2FnZSBhcyBNZXNzYWdlVHlwZSB9IGZyb20gJy4vdHlwZXMvbWVzc2FnZS5qcydcbmltcG9ydCB7IGFzc2VydE1pblZlcnNpb24gfSBmcm9tICcuL3V0aWxzL2F1dG9VcGRhdGVyLmpzJ1xuaW1wb3J0IHtcbiAgQ0xBVURFX0lOX0NIUk9NRV9TS0lMTF9ISU5ULFxuICBDTEFVREVfSU5fQ0hST01FX1NLSUxMX0hJTlRfV0lUSF9XRUJCUk9XU0VSLFxufSBmcm9tICcuL3V0aWxzL2NsYXVkZUluQ2hyb21lL3Byb21wdC5qcydcbmltcG9ydCB7XG4gIHNldHVwQ2xhdWRlSW5DaHJvbWUsXG4gIHNob3VsZEF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSxcbiAgc2hvdWxkRW5hYmxlQ2xhdWRlSW5DaHJvbWUsXG59IGZyb20gJy4vdXRpbHMvY2xhdWRlSW5DaHJvbWUvc2V0dXAuanMnXG5pbXBvcnQgeyBnZXRDb250ZXh0V2luZG93Rm9yTW9kZWwgfSBmcm9tICcuL3V0aWxzL2NvbnRleHQuanMnXG5pbXBvcnQgeyBsb2FkQ29udmVyc2F0aW9uRm9yUmVzdW1lIH0gZnJvbSAnLi91dGlscy9jb252ZXJzYXRpb25SZWNvdmVyeS5qcydcbmltcG9ydCB7IGJ1aWxkRGVlcExpbmtCYW5uZXIgfSBmcm9tICcuL3V0aWxzL2RlZXBMaW5rL2Jhbm5lci5qcydcbmltcG9ydCB7XG4gIGhhc05vZGVPcHRpb24sXG4gIGlzQmFyZU1vZGUsXG4gIGlzRW52VHJ1dGh5LFxuICBpc0luUHJvdGVjdGVkTmFtZXNwYWNlLFxufSBmcm9tICcuL3V0aWxzL2VudlV0aWxzLmpzJ1xuaW1wb3J0IHsgcmVmcmVzaEV4YW1wbGVDb21tYW5kcyB9IGZyb20gJy4vdXRpbHMvZXhhbXBsZUNvbW1hbmRzLmpzJ1xuaW1wb3J0IHR5cGUgeyBGcHNNZXRyaWNzIH0gZnJvbSAnLi91dGlscy9mcHNUcmFja2VyLmpzJ1xuaW1wb3J0IHsgZ2V0V29ya3RyZWVQYXRocyB9IGZyb20gJy4vdXRpbHMvZ2V0V29ya3RyZWVQYXRocy5qcydcbmltcG9ydCB7XG4gIGZpbmRHaXRSb290LFxuICBnZXRCcmFuY2gsXG4gIGdldElzR2l0LFxuICBnZXRXb3JrdHJlZUNvdW50LFxufSBmcm9tICcuL3V0aWxzL2dpdC5qcydcbmltcG9ydCB7IGdldEdoQXV0aFN0YXR1cyB9IGZyb20gJy4vdXRpbHMvZ2l0aHViL2doQXV0aFN0YXR1cy5qcydcbmltcG9ydCB7IHNhZmVQYXJzZUpTT04gfSBmcm9tICcuL3V0aWxzL2pzb24uanMnXG5pbXBvcnQgeyBsb2dFcnJvciB9IGZyb20gJy4vdXRpbHMvbG9nLmpzJ1xuaW1wb3J0IHsgZ2V0TW9kZWxEZXByZWNhdGlvbldhcm5pbmcgfSBmcm9tICcuL3V0aWxzL21vZGVsL2RlcHJlY2F0aW9uLmpzJ1xuaW1wb3J0IHtcbiAgZ2V0RGVmYXVsdE1haW5Mb29wTW9kZWwsXG4gIGdldFVzZXJTcGVjaWZpZWRNb2RlbFNldHRpbmcsXG4gIG5vcm1hbGl6ZU1vZGVsU3RyaW5nRm9yQVBJLFxuICBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbCxcbn0gZnJvbSAnLi91dGlscy9tb2RlbC9tb2RlbC5qcydcbmltcG9ydCB7IGVuc3VyZU1vZGVsU3RyaW5nc0luaXRpYWxpemVkIH0gZnJvbSAnLi91dGlscy9tb2RlbC9tb2RlbFN0cmluZ3MuanMnXG5pbXBvcnQgeyBQRVJNSVNTSU9OX01PREVTIH0gZnJvbSAnLi91dGlscy9wZXJtaXNzaW9ucy9QZXJtaXNzaW9uTW9kZS5qcydcbmltcG9ydCB7XG4gIGNoZWNrQW5kRGlzYWJsZUJ5cGFzc1Blcm1pc3Npb25zLFxuICBnZXRBdXRvTW9kZUVuYWJsZWRTdGF0ZUlmQ2FjaGVkLFxuICBpbml0aWFsaXplVG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICBpbml0aWFsUGVybWlzc2lvbk1vZGVGcm9tQ0xJLFxuICBpc0RlZmF1bHRQZXJtaXNzaW9uTW9kZUF1dG8sXG4gIHBhcnNlVG9vbExpc3RGcm9tQ0xJLFxuICByZW1vdmVEYW5nZXJvdXNQZXJtaXNzaW9ucyxcbiAgc3RyaXBEYW5nZXJvdXNQZXJtaXNzaW9uc0ZvckF1dG9Nb2RlLFxuICB2ZXJpZnlBdXRvTW9kZUdhdGVBY2Nlc3MsXG59IGZyb20gJy4vdXRpbHMvcGVybWlzc2lvbnMvcGVybWlzc2lvblNldHVwLmpzJ1xuaW1wb3J0IHsgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQgfSBmcm9tICcuL3V0aWxzL3BsdWdpbnMvY2FjaGVVdGlscy5qcydcbmltcG9ydCB7IGluaXRpYWxpemVWZXJzaW9uZWRQbHVnaW5zIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL2luc3RhbGxlZFBsdWdpbnNNYW5hZ2VyLmpzJ1xuaW1wb3J0IHsgZ2V0TWFuYWdlZFBsdWdpbk5hbWVzIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL21hbmFnZWRQbHVnaW5zLmpzJ1xuaW1wb3J0IHsgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSB9IGZyb20gJy4vdXRpbHMvcGx1Z2lucy9vcnBoYW5lZFBsdWdpbkZpbHRlci5qcydcbmltcG9ydCB7IGdldFBsdWdpblNlZWREaXJzIH0gZnJvbSAnLi91dGlscy9wbHVnaW5zL3BsdWdpbkRpcmVjdG9yaWVzLmpzJ1xuaW1wb3J0IHsgY291bnRGaWxlc1JvdW5kZWRSZyB9IGZyb20gJy4vdXRpbHMvcmlwZ3JlcC5qcydcbmltcG9ydCB7XG4gIHByb2Nlc3NTZXNzaW9uU3RhcnRIb29rcyxcbiAgcHJvY2Vzc1NldHVwSG9va3MsXG59IGZyb20gJy4vdXRpbHMvc2Vzc2lvblN0YXJ0LmpzJ1xuaW1wb3J0IHtcbiAgY2FjaGVTZXNzaW9uVGl0bGUsXG4gIGdldFNlc3Npb25JZEZyb21Mb2csXG4gIGxvYWRUcmFuc2NyaXB0RnJvbUZpbGUsXG4gIHNhdmVBZ2VudFNldHRpbmcsXG4gIHNhdmVNb2RlLFxuICBzZWFyY2hTZXNzaW9uc0J5Q3VzdG9tVGl0bGUsXG4gIHNlc3Npb25JZEV4aXN0cyxcbn0gZnJvbSAnLi91dGlscy9zZXNzaW9uU3RvcmFnZS5qcydcbmltcG9ydCB7IGVuc3VyZU1kbVNldHRpbmdzTG9hZGVkIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9tZG0vc2V0dGluZ3MuanMnXG5pbXBvcnQge1xuICBnZXRJbml0aWFsU2V0dGluZ3MsXG4gIGdldE1hbmFnZWRTZXR0aW5nc0tleXNGb3JMb2dnaW5nLFxuICBnZXRTZXR0aW5nc0ZvclNvdXJjZSxcbiAgZ2V0U2V0dGluZ3NXaXRoRXJyb3JzLFxufSBmcm9tICcuL3V0aWxzL3NldHRpbmdzL3NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgcmVzZXRTZXR0aW5nc0NhY2hlIH0gZnJvbSAnLi91dGlscy9zZXR0aW5ncy9zZXR0aW5nc0NhY2hlLmpzJ1xuaW1wb3J0IHR5cGUgeyBWYWxpZGF0aW9uRXJyb3IgfSBmcm9tICcuL3V0aWxzL3NldHRpbmdzL3ZhbGlkYXRpb24uanMnXG5pbXBvcnQge1xuICBERUZBVUxUX1RBU0tTX01PREVfVEFTS19MSVNUX0lELFxuICBUQVNLX1NUQVRVU0VTLFxufSBmcm9tICcuL3V0aWxzL3Rhc2tzLmpzJ1xuaW1wb3J0IHtcbiAgbG9nUGx1Z2luTG9hZEVycm9ycyxcbiAgbG9nUGx1Z2luc0VuYWJsZWRGb3JTZXNzaW9uLFxufSBmcm9tICcuL3V0aWxzL3RlbGVtZXRyeS9wbHVnaW5UZWxlbWV0cnkuanMnXG5pbXBvcnQgeyBsb2dTa2lsbHNMb2FkZWQgfSBmcm9tICcuL3V0aWxzL3RlbGVtZXRyeS9za2lsbExvYWRlZEV2ZW50LmpzJ1xuaW1wb3J0IHsgZ2VuZXJhdGVUZW1wRmlsZVBhdGggfSBmcm9tICcuL3V0aWxzL3RlbXBmaWxlLmpzJ1xuaW1wb3J0IHsgdmFsaWRhdGVVdWlkIH0gZnJvbSAnLi91dGlscy91dWlkLmpzJ1xuLy8gUGx1Z2luIHN0YXJ0dXAgY2hlY2tzIGFyZSBub3cgaGFuZGxlZCBub24tYmxvY2tpbmdseSBpbiBSRVBMLnRzeFxuXG5pbXBvcnQgeyByZWdpc3Rlck1jcEFkZENvbW1hbmQgfSBmcm9tICdzcmMvY29tbWFuZHMvbWNwL2FkZENvbW1hbmQuanMnXG5pbXBvcnQgeyByZWdpc3Rlck1jcFhhYUlkcENvbW1hbmQgfSBmcm9tICdzcmMvY29tbWFuZHMvbWNwL3hhYUlkcENvbW1hbmQuanMnXG5pbXBvcnQgeyBsb2dQZXJtaXNzaW9uQ29udGV4dEZvckFudHMgfSBmcm9tICdzcmMvc2VydmljZXMvaW50ZXJuYWxMb2dnaW5nLmpzJ1xuaW1wb3J0IHsgZmV0Y2hDbGF1ZGVBSU1jcENvbmZpZ3NJZkVsaWdpYmxlIH0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC9jbGF1ZGVhaS5qcydcbmltcG9ydCB7IGNsZWFyU2VydmVyQ2FjaGUgfSBmcm9tICdzcmMvc2VydmljZXMvbWNwL2NsaWVudC5qcydcbmltcG9ydCB7XG4gIGFyZU1jcENvbmZpZ3NBbGxvd2VkV2l0aEVudGVycHJpc2VNY3BDb25maWcsXG4gIGRlZHVwQ2xhdWRlQWlNY3BTZXJ2ZXJzLFxuICBkb2VzRW50ZXJwcmlzZU1jcENvbmZpZ0V4aXN0LFxuICBmaWx0ZXJNY3BTZXJ2ZXJzQnlQb2xpY3ksXG4gIGdldENsYXVkZUNvZGVNY3BDb25maWdzLFxuICBnZXRNY3BTZXJ2ZXJTaWduYXR1cmUsXG4gIHBhcnNlTWNwQ29uZmlnLFxuICBwYXJzZU1jcENvbmZpZ0Zyb21GaWxlUGF0aCxcbn0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC9jb25maWcuanMnXG5pbXBvcnQge1xuICBleGNsdWRlQ29tbWFuZHNCeVNlcnZlcixcbiAgZXhjbHVkZVJlc291cmNlc0J5U2VydmVyLFxufSBmcm9tICdzcmMvc2VydmljZXMvbWNwL3V0aWxzLmpzJ1xuaW1wb3J0IHsgaXNYYWFFbmFibGVkIH0gZnJvbSAnc3JjL3NlcnZpY2VzL21jcC94YWFJZHBMb2dpbi5qcydcbmltcG9ydCB7IGdldFJlbGV2YW50VGlwcyB9IGZyb20gJ3NyYy9zZXJ2aWNlcy90aXBzL3RpcFJlZ2lzdHJ5LmpzJ1xuaW1wb3J0IHsgbG9nQ29udGV4dE1ldHJpY3MgfSBmcm9tICdzcmMvdXRpbHMvYXBpLmpzJ1xuaW1wb3J0IHtcbiAgQ0xBVURFX0lOX0NIUk9NRV9NQ1BfU0VSVkVSX05BTUUsXG4gIGlzQ2xhdWRlSW5DaHJvbWVNQ1BTZXJ2ZXIsXG59IGZyb20gJ3NyYy91dGlscy9jbGF1ZGVJbkNocm9tZS9jb21tb24uanMnXG5pbXBvcnQgeyByZWdpc3RlckNsZWFudXAgfSBmcm9tICdzcmMvdXRpbHMvY2xlYW51cFJlZ2lzdHJ5LmpzJ1xuaW1wb3J0IHsgZWFnZXJQYXJzZUNsaUZsYWcgfSBmcm9tICdzcmMvdXRpbHMvY2xpQXJncy5qcydcbmltcG9ydCB7IGNyZWF0ZUVtcHR5QXR0cmlidXRpb25TdGF0ZSB9IGZyb20gJ3NyYy91dGlscy9jb21taXRBdHRyaWJ1dGlvbi5qcydcbmltcG9ydCB7XG4gIGNvdW50Q29uY3VycmVudFNlc3Npb25zLFxuICByZWdpc3RlclNlc3Npb24sXG4gIHVwZGF0ZVNlc3Npb25OYW1lLFxufSBmcm9tICdzcmMvdXRpbHMvY29uY3VycmVudFNlc3Npb25zLmpzJ1xuaW1wb3J0IHsgZ2V0Q3dkIH0gZnJvbSAnc3JjL3V0aWxzL2N3ZC5qcydcbmltcG9ydCB7IGxvZ0ZvckRlYnVnZ2luZywgc2V0SGFzRm9ybWF0dGVkT3V0cHV0IH0gZnJvbSAnc3JjL3V0aWxzL2RlYnVnLmpzJ1xuaW1wb3J0IHtcbiAgZXJyb3JNZXNzYWdlLFxuICBnZXRFcnJub0NvZGUsXG4gIGlzRU5PRU5ULFxuICBUZWxlcG9ydE9wZXJhdGlvbkVycm9yLFxuICB0b0Vycm9yLFxufSBmcm9tICdzcmMvdXRpbHMvZXJyb3JzLmpzJ1xuaW1wb3J0IHsgZ2V0RnNJbXBsZW1lbnRhdGlvbiwgc2FmZVJlc29sdmVQYXRoIH0gZnJvbSAnc3JjL3V0aWxzL2ZzT3BlcmF0aW9ucy5qcydcbmltcG9ydCB7XG4gIGdyYWNlZnVsU2h1dGRvd24sXG4gIGdyYWNlZnVsU2h1dGRvd25TeW5jLFxufSBmcm9tICdzcmMvdXRpbHMvZ3JhY2VmdWxTaHV0ZG93bi5qcydcbmltcG9ydCB7IHNldEFsbEhvb2tFdmVudHNFbmFibGVkIH0gZnJvbSAnc3JjL3V0aWxzL2hvb2tzL2hvb2tFdmVudHMuanMnXG5pbXBvcnQgeyByZWZyZXNoTW9kZWxDYXBhYmlsaXRpZXMgfSBmcm9tICdzcmMvdXRpbHMvbW9kZWwvbW9kZWxDYXBhYmlsaXRpZXMuanMnXG5pbXBvcnQgeyBwZWVrRm9yU3RkaW5EYXRhLCB3cml0ZVRvU3RkZXJyIH0gZnJvbSAnc3JjL3V0aWxzL3Byb2Nlc3MuanMnXG5pbXBvcnQgeyBzZXRDd2QgfSBmcm9tICdzcmMvdXRpbHMvU2hlbGwuanMnXG5pbXBvcnQge1xuICB0eXBlIFByb2Nlc3NlZFJlc3VtZSxcbiAgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24sXG59IGZyb20gJ3NyYy91dGlscy9zZXNzaW9uUmVzdG9yZS5qcydcbmltcG9ydCB7IHBhcnNlU2V0dGluZ1NvdXJjZXNGbGFnIH0gZnJvbSAnc3JjL3V0aWxzL3NldHRpbmdzL2NvbnN0YW50cy5qcydcbmltcG9ydCB7IHBsdXJhbCB9IGZyb20gJ3NyYy91dGlscy9zdHJpbmdVdGlscy5qcydcbmltcG9ydCB7XG4gIHR5cGUgQ2hhbm5lbEVudHJ5LFxuICBnZXRJbml0aWFsTWFpbkxvb3BNb2RlbCxcbiAgZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24sXG4gIGdldFNka0JldGFzLFxuICBnZXRTZXNzaW9uSWQsXG4gIGdldFVzZXJNc2dPcHRJbixcbiAgc2V0QWxsb3dlZENoYW5uZWxzLFxuICBzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMsXG4gIHNldENocm9tZUZsYWdPdmVycmlkZSxcbiAgc2V0Q2xpZW50VHlwZSxcbiAgc2V0Q3dkU3RhdGUsXG4gIHNldERpcmVjdENvbm5lY3RTZXJ2ZXJVcmwsXG4gIHNldEZsYWdTZXR0aW5nc1BhdGgsXG4gIHNldEluaXRpYWxNYWluTG9vcE1vZGVsLFxuICBzZXRJbmxpbmVQbHVnaW5zLFxuICBzZXRJc0ludGVyYWN0aXZlLFxuICBzZXRLYWlyb3NBY3RpdmUsXG4gIHNldE9yaWdpbmFsQ3dkLFxuICBzZXRRdWVzdGlvblByZXZpZXdGb3JtYXQsXG4gIHNldFNka0JldGFzLFxuICBzZXRTZXNzaW9uQnlwYXNzUGVybWlzc2lvbnNNb2RlLFxuICBzZXRTZXNzaW9uUGVyc2lzdGVuY2VEaXNhYmxlZCxcbiAgc2V0U2Vzc2lvblNvdXJjZSxcbiAgc2V0VXNlck1zZ09wdEluLFxuICBzd2l0Y2hTZXNzaW9uLFxufSBmcm9tICcuL2Jvb3RzdHJhcC9zdGF0ZS5qcydcblxuLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuY29uc3QgYXV0b01vZGVTdGF0ZU1vZHVsZSA9IGZlYXR1cmUoJ1RSQU5TQ1JJUFRfQ0xBU1NJRklFUicpXG4gID8gKHJlcXVpcmUoJy4vdXRpbHMvcGVybWlzc2lvbnMvYXV0b01vZGVTdGF0ZS5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdXRpbHMvcGVybWlzc2lvbnMvYXV0b01vZGVTdGF0ZS5qcycpKVxuICA6IG51bGxcblxuLy8gVGVsZXBvcnRSZXBvTWlzbWF0Y2hEaWFsb2csIFRlbGVwb3J0UmVzdW1lV3JhcHBlciBkeW5hbWljYWxseSBpbXBvcnRlZCBhdCBjYWxsIHNpdGVzXG5pbXBvcnQgeyBtaWdyYXRlQXV0b1VwZGF0ZXNUb1NldHRpbmdzIH0gZnJvbSAnLi9taWdyYXRpb25zL21pZ3JhdGVBdXRvVXBkYXRlc1RvU2V0dGluZ3MuanMnXG5pbXBvcnQgeyBtaWdyYXRlQnlwYXNzUGVybWlzc2lvbnNBY2NlcHRlZFRvU2V0dGluZ3MgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZUJ5cGFzc1Blcm1pc3Npb25zQWNjZXB0ZWRUb1NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUVuYWJsZUFsbFByb2plY3RNY3BTZXJ2ZXJzVG9TZXR0aW5ncyB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlRW5hYmxlQWxsUHJvamVjdE1jcFNlcnZlcnNUb1NldHRpbmdzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUZlbm5lY1RvT3B1cyB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlRmVubmVjVG9PcHVzLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZUxlZ2FjeU9wdXNUb0N1cnJlbnQuanMnXG5pbXBvcnQgeyBtaWdyYXRlT3B1c1RvT3B1czFtIH0gZnJvbSAnLi9taWdyYXRpb25zL21pZ3JhdGVPcHVzVG9PcHVzMW0uanMnXG5pbXBvcnQgeyBtaWdyYXRlUmVwbEJyaWRnZUVuYWJsZWRUb1JlbW90ZUNvbnRyb2xBdFN0YXJ0dXAgfSBmcm9tICcuL21pZ3JhdGlvbnMvbWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZVNvbm5ldDFtVG9Tb25uZXQ0NSB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1LmpzJ1xuaW1wb3J0IHsgbWlncmF0ZVNvbm5ldDQ1VG9Tb25uZXQ0NiB9IGZyb20gJy4vbWlncmF0aW9ucy9taWdyYXRlU29ubmV0NDVUb1Nvbm5ldDQ2LmpzJ1xuaW1wb3J0IHsgcmVzZXRBdXRvTW9kZU9wdEluRm9yRGVmYXVsdE9mZmVyIH0gZnJvbSAnLi9taWdyYXRpb25zL3Jlc2V0QXV0b01vZGVPcHRJbkZvckRlZmF1bHRPZmZlci5qcydcbmltcG9ydCB7IHJlc2V0UHJvVG9PcHVzRGVmYXVsdCB9IGZyb20gJy4vbWlncmF0aW9ucy9yZXNldFByb1RvT3B1c0RlZmF1bHQuanMnXG5pbXBvcnQgeyBjcmVhdGVSZW1vdGVTZXNzaW9uQ29uZmlnIH0gZnJvbSAnLi9yZW1vdGUvUmVtb3RlU2Vzc2lvbk1hbmFnZXIuanMnXG4vKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbi8vIHRlbGVwb3J0V2l0aFByb2dyZXNzIGR5bmFtaWNhbGx5IGltcG9ydGVkIGF0IGNhbGwgc2l0ZVxuaW1wb3J0IHtcbiAgY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24sXG4gIERpcmVjdENvbm5lY3RFcnJvcixcbn0gZnJvbSAnLi9zZXJ2ZXIvY3JlYXRlRGlyZWN0Q29ubmVjdFNlc3Npb24uanMnXG5pbXBvcnQgeyBpbml0aWFsaXplTHNwU2VydmVyTWFuYWdlciB9IGZyb20gJy4vc2VydmljZXMvbHNwL21hbmFnZXIuanMnXG5pbXBvcnQgeyBzaG91bGRFbmFibGVQcm9tcHRTdWdnZXN0aW9uIH0gZnJvbSAnLi9zZXJ2aWNlcy9Qcm9tcHRTdWdnZXN0aW9uL3Byb21wdFN1Z2dlc3Rpb24uanMnXG5pbXBvcnQge1xuICB0eXBlIEFwcFN0YXRlLFxuICBnZXREZWZhdWx0QXBwU3RhdGUsXG4gIElETEVfU1BFQ1VMQVRJT05fU1RBVEUsXG59IGZyb20gJy4vc3RhdGUvQXBwU3RhdGVTdG9yZS5qcydcbmltcG9ydCB7IG9uQ2hhbmdlQXBwU3RhdGUgfSBmcm9tICcuL3N0YXRlL29uQ2hhbmdlQXBwU3RhdGUuanMnXG5pbXBvcnQgeyBjcmVhdGVTdG9yZSB9IGZyb20gJy4vc3RhdGUvc3RvcmUuanMnXG5pbXBvcnQgeyBhc1Nlc3Npb25JZCB9IGZyb20gJy4vdHlwZXMvaWRzLmpzJ1xuaW1wb3J0IHsgZmlsdGVyQWxsb3dlZFNka0JldGFzIH0gZnJvbSAnLi91dGlscy9iZXRhcy5qcydcbmltcG9ydCB7IGlzSW5CdW5kbGVkTW9kZSwgaXNSdW5uaW5nV2l0aEJ1biB9IGZyb20gJy4vdXRpbHMvYnVuZGxlZE1vZGUuanMnXG5pbXBvcnQgeyBsb2dGb3JEaWFnbm9zdGljc05vUElJIH0gZnJvbSAnLi91dGlscy9kaWFnTG9ncy5qcydcbmltcG9ydCB7XG4gIGZpbHRlckV4aXN0aW5nUGF0aHMsXG4gIGdldEtub3duUGF0aHNGb3JSZXBvLFxufSBmcm9tICcuL3V0aWxzL2dpdGh1YlJlcG9QYXRoTWFwcGluZy5qcydcbmltcG9ydCB7XG4gIGNsZWFyUGx1Z2luQ2FjaGUsXG4gIGxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5LFxufSBmcm9tICcuL3V0aWxzL3BsdWdpbnMvcGx1Z2luTG9hZGVyLmpzJ1xuaW1wb3J0IHsgbWlncmF0ZUNoYW5nZWxvZ0Zyb21Db25maWcgfSBmcm9tICcuL3V0aWxzL3JlbGVhc2VOb3Rlcy5qcydcbmltcG9ydCB7IFNhbmRib3hNYW5hZ2VyIH0gZnJvbSAnLi91dGlscy9zYW5kYm94L3NhbmRib3gtYWRhcHRlci5qcydcbmltcG9ydCB7IGZldGNoU2Vzc2lvbiwgcHJlcGFyZUFwaVJlcXVlc3QgfSBmcm9tICcuL3V0aWxzL3RlbGVwb3J0L2FwaS5qcydcbmltcG9ydCB7XG4gIGNoZWNrT3V0VGVsZXBvcnRlZFNlc3Npb25CcmFuY2gsXG4gIHByb2Nlc3NNZXNzYWdlc0ZvclRlbGVwb3J0UmVzdW1lLFxuICB0ZWxlcG9ydFRvUmVtb3RlV2l0aEVycm9ySGFuZGxpbmcsXG4gIHZhbGlkYXRlR2l0U3RhdGUsXG4gIHZhbGlkYXRlU2Vzc2lvblJlcG9zaXRvcnksXG59IGZyb20gJy4vdXRpbHMvdGVsZXBvcnQuanMnXG5pbXBvcnQge1xuICBzaG91bGRFbmFibGVUaGlua2luZ0J5RGVmYXVsdCxcbiAgdHlwZSBUaGlua2luZ0NvbmZpZyxcbn0gZnJvbSAnLi91dGlscy90aGlua2luZy5qcydcbmltcG9ydCB7IGluaXRVc2VyLCByZXNldFVzZXJDYWNoZSB9IGZyb20gJy4vdXRpbHMvdXNlci5qcydcbmltcG9ydCB7XG4gIGdldFRtdXhJbnN0YWxsSW5zdHJ1Y3Rpb25zLFxuICBpc1RtdXhBdmFpbGFibGUsXG4gIHBhcnNlUFJSZWZlcmVuY2UsXG59IGZyb20gJy4vdXRpbHMvd29ya3RyZWUuanMnXG5cbi8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xucHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fdHN4X2ltcG9ydHNfbG9hZGVkJylcblxuLyoqXG4gKiBMb2cgbWFuYWdlZCBzZXR0aW5ncyBrZXlzIHRvIFN0YXRzaWcgZm9yIGFuYWx5dGljcy5cbiAqIFRoaXMgaXMgY2FsbGVkIGFmdGVyIGluaXQoKSBjb21wbGV0ZXMgdG8gZW5zdXJlIHNldHRpbmdzIGFyZSBsb2FkZWRcbiAqIGFuZCBlbnZpcm9ubWVudCB2YXJpYWJsZXMgYXJlIGFwcGxpZWQgYmVmb3JlIG1vZGVsIHJlc29sdXRpb24uXG4gKi9cbmZ1bmN0aW9uIGxvZ01hbmFnZWRTZXR0aW5ncygpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwb2xpY3lTZXR0aW5ncyA9IGdldFNldHRpbmdzRm9yU291cmNlKCdwb2xpY3lTZXR0aW5ncycpXG4gICAgaWYgKHBvbGljeVNldHRpbmdzKSB7XG4gICAgICBjb25zdCBhbGxLZXlzID0gZ2V0TWFuYWdlZFNldHRpbmdzS2V5c0ZvckxvZ2dpbmcocG9saWN5U2V0dGluZ3MpXG4gICAgICBsb2dFdmVudCgndGVuZ3VfbWFuYWdlZF9zZXR0aW5nc19sb2FkZWQnLCB7XG4gICAgICAgIGtleUNvdW50OiBhbGxLZXlzLmxlbmd0aCxcbiAgICAgICAga2V5czogYWxsS2V5cy5qb2luKFxuICAgICAgICAgICcsJyxcbiAgICAgICAgKSBhcyB1bmtub3duIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KVxuICAgIH1cbiAgfSBjYXRjaCB7XG4gICAgLy8gU2lsZW50bHkgaWdub3JlIGVycm9ycyAtIHRoaXMgaXMganVzdCBmb3IgYW5hbHl0aWNzXG4gIH1cbn1cblxuLy8gQ2hlY2sgaWYgcnVubmluZyBpbiBkZWJ1Zy9pbnNwZWN0aW9uIG1vZGVcbmZ1bmN0aW9uIGlzQmVpbmdEZWJ1Z2dlZCgpIHtcbiAgY29uc3QgaXNCdW4gPSBpc1J1bm5pbmdXaXRoQnVuKClcblxuICAvLyBDaGVjayBmb3IgaW5zcGVjdCBmbGFncyBpbiBwcm9jZXNzIGFyZ3VtZW50cyAoaW5jbHVkaW5nIGFsbCB2YXJpYW50cylcbiAgY29uc3QgaGFzSW5zcGVjdEFyZyA9IHByb2Nlc3MuZXhlY0FyZ3Yuc29tZShhcmcgPT4ge1xuICAgIGlmIChpc0J1bikge1xuICAgICAgLy8gTm90ZTogQnVuIGhhcyBhbiBpc3N1ZSB3aXRoIHNpbmdsZS1maWxlIGV4ZWN1dGFibGVzIHdoZXJlIGFwcGxpY2F0aW9uIGFyZ3VtZW50c1xuICAgICAgLy8gZnJvbSBwcm9jZXNzLmFyZ3YgbGVhayBpbnRvIHByb2Nlc3MuZXhlY0FyZ3YgKHNpbWlsYXIgdG8gaHR0cHM6Ly9naXRodWIuY29tL292ZW4tc2gvYnVuL2lzc3Vlcy8xMTY3MylcbiAgICAgIC8vIFRoaXMgYnJlYWtzIHVzZSBvZiAtLWRlYnVnIG1vZGUgaWYgd2Ugb21pdCB0aGlzIGJyYW5jaFxuICAgICAgLy8gV2UncmUgZmluZSB0byBza2lwIHRoYXQgY2hlY2ssIGJlY2F1c2UgQnVuIGRvZXNuJ3Qgc3VwcG9ydCBOb2RlLmpzIGxlZ2FjeSAtLWRlYnVnIG9yIC0tZGVidWctYnJrIGZsYWdzXG4gICAgICByZXR1cm4gLy0taW5zcGVjdCgtYnJrKT8vLnRlc3QoYXJnKVxuICAgIH0gZWxzZSB7XG4gICAgICAvLyBJbiBOb2RlLmpzLCBjaGVjayBmb3IgYm90aCAtLWluc3BlY3QgYW5kIGxlZ2FjeSAtLWRlYnVnIGZsYWdzXG4gICAgICByZXR1cm4gLy0taW5zcGVjdCgtYnJrKT98LS1kZWJ1ZygtYnJrKT8vLnRlc3QoYXJnKVxuICAgIH1cbiAgfSlcblxuICAvLyBDaGVjayBpZiBOT0RFX09QVElPTlMgY29udGFpbnMgaW5zcGVjdCBmbGFnc1xuICBjb25zdCBoYXNJbnNwZWN0RW52ID1cbiAgICBwcm9jZXNzLmVudi5OT0RFX09QVElPTlMgJiZcbiAgICAvLS1pbnNwZWN0KC1icmspP3wtLWRlYnVnKC1icmspPy8udGVzdChwcm9jZXNzLmVudi5OT0RFX09QVElPTlMpXG5cbiAgLy8gQ2hlY2sgaWYgaW5zcGVjdG9yIGlzIGF2YWlsYWJsZSBhbmQgYWN0aXZlIChpbmRpY2F0ZXMgZGVidWdnaW5nKVxuICB0cnkge1xuICAgIC8vIER5bmFtaWMgaW1wb3J0IHdvdWxkIGJlIGJldHRlciBidXQgaXMgYXN5bmMgLSB1c2UgZ2xvYmFsIG9iamVjdCBpbnN0ZWFkXG4gICAgLy8gZXNsaW50LWRpc2FibGUtbmV4dC1saW5lIEB0eXBlc2NyaXB0LWVzbGludC9uby1leHBsaWNpdC1hbnlcbiAgICBjb25zdCBpbnNwZWN0b3IgPSAoZ2xvYmFsIGFzIGFueSkucmVxdWlyZSgnaW5zcGVjdG9yJylcbiAgICBjb25zdCBoYXNJbnNwZWN0b3JVcmwgPSAhIWluc3BlY3Rvci51cmwoKVxuICAgIHJldHVybiBoYXNJbnNwZWN0b3JVcmwgfHwgaGFzSW5zcGVjdEFyZyB8fCBoYXNJbnNwZWN0RW52XG4gIH0gY2F0Y2gge1xuICAgIC8vIElnbm9yZSBlcnJvciBhbmQgZmFsbCBiYWNrIHRvIGFyZ3VtZW50IGRldGVjdGlvblxuICAgIHJldHVybiBoYXNJbnNwZWN0QXJnIHx8IGhhc0luc3BlY3RFbnZcbiAgfVxufVxuXG4vLyBFeGl0IGlmIHdlIGRldGVjdCBub2RlIGRlYnVnZ2luZyBvciBpbnNwZWN0aW9uXG5pZiAoXCJleHRlcm5hbFwiICE9PSAnYW50JyAmJiBpc0JlaW5nRGVidWdnZWQoKSkge1xuICAvLyBVc2UgcHJvY2Vzcy5leGl0IGRpcmVjdGx5IGhlcmUgc2luY2Ugd2UncmUgaW4gdGhlIHRvcC1sZXZlbCBjb2RlIGJlZm9yZSBpbXBvcnRzXG4gIC8vIGFuZCBncmFjZWZ1bFNodXRkb3duIGlzIG5vdCB5ZXQgYXZhaWxhYmxlXG4gIC8vIGVzbGludC1kaXNhYmxlLW5leHQtbGluZSBjdXN0b20tcnVsZXMvbm8tdG9wLWxldmVsLXNpZGUtZWZmZWN0c1xuICBwcm9jZXNzLmV4aXQoMSlcbn1cblxuLyoqXG4gKiBQZXItc2Vzc2lvbiBza2lsbC9wbHVnaW4gdGVsZW1ldHJ5LiBDYWxsZWQgZnJvbSBib3RoIHRoZSBpbnRlcmFjdGl2ZSBwYXRoXG4gKiBhbmQgdGhlIGhlYWRsZXNzIC1wIHBhdGggKGJlZm9yZSBydW5IZWFkbGVzcykgXHUyMDE0IGJvdGggZ28gdGhyb3VnaFxuICogbWFpbi50c3ggYnV0IGJyYW5jaCBiZWZvcmUgdGhlIGludGVyYWN0aXZlIHN0YXJ0dXAgcGF0aCwgc28gaXQgbmVlZHMgdHdvXG4gKiBjYWxsIHNpdGVzIGhlcmUgcmF0aGVyIHRoYW4gb25lIGhlcmUgKyBvbmUgaW4gUXVlcnlFbmdpbmUuXG4gKi9cbmZ1bmN0aW9uIGxvZ1Nlc3Npb25UZWxlbWV0cnkoKTogdm9pZCB7XG4gIGNvbnN0IG1vZGVsID0gcGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwoXG4gICAgZ2V0SW5pdGlhbE1haW5Mb29wTW9kZWwoKSA/PyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpLFxuICApXG4gIHZvaWQgbG9nU2tpbGxzTG9hZGVkKGdldEN3ZCgpLCBnZXRDb250ZXh0V2luZG93Rm9yTW9kZWwobW9kZWwsIGdldFNka0JldGFzKCkpKVxuICB2b2lkIGxvYWRBbGxQbHVnaW5zQ2FjaGVPbmx5KClcbiAgICAudGhlbigoeyBlbmFibGVkLCBlcnJvcnMgfSkgPT4ge1xuICAgICAgY29uc3QgbWFuYWdlZE5hbWVzID0gZ2V0TWFuYWdlZFBsdWdpbk5hbWVzKClcbiAgICAgIGxvZ1BsdWdpbnNFbmFibGVkRm9yU2Vzc2lvbihlbmFibGVkLCBtYW5hZ2VkTmFtZXMsIGdldFBsdWdpblNlZWREaXJzKCkpXG4gICAgICBsb2dQbHVnaW5Mb2FkRXJyb3JzKGVycm9ycywgbWFuYWdlZE5hbWVzKVxuICAgIH0pXG4gICAgLmNhdGNoKGVyciA9PiBsb2dFcnJvcihlcnIpKVxufVxuXG5mdW5jdGlvbiBnZXRDZXJ0RW52VmFyVGVsZW1ldHJ5KCk6IFJlY29yZDxzdHJpbmcsIGJvb2xlYW4+IHtcbiAgY29uc3QgcmVzdWx0OiBSZWNvcmQ8c3RyaW5nLCBib29sZWFuPiA9IHt9XG4gIGlmIChwcm9jZXNzLmVudi5OT0RFX0VYVFJBX0NBX0NFUlRTKSB7XG4gICAgcmVzdWx0Lmhhc19ub2RlX2V4dHJhX2NhX2NlcnRzID0gdHJ1ZVxuICB9XG4gIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9DTElFTlRfQ0VSVCkge1xuICAgIHJlc3VsdC5oYXNfY2xpZW50X2NlcnQgPSB0cnVlXG4gIH1cbiAgaWYgKGhhc05vZGVPcHRpb24oJy0tdXNlLXN5c3RlbS1jYScpKSB7XG4gICAgcmVzdWx0Lmhhc191c2Vfc3lzdGVtX2NhID0gdHJ1ZVxuICB9XG4gIGlmIChoYXNOb2RlT3B0aW9uKCctLXVzZS1vcGVuc3NsLWNhJykpIHtcbiAgICByZXN1bHQuaGFzX3VzZV9vcGVuc3NsX2NhID0gdHJ1ZVxuICB9XG4gIHJldHVybiByZXN1bHRcbn1cblxuYXN5bmMgZnVuY3Rpb24gbG9nU3RhcnR1cFRlbGVtZXRyeSgpOiBQcm9taXNlPHZvaWQ+IHtcbiAgaWYgKGlzQW5hbHl0aWNzRGlzYWJsZWQoKSkgcmV0dXJuXG4gIGNvbnN0IFtpc0dpdCwgd29ya3RyZWVDb3VudCwgZ2hBdXRoU3RhdHVzXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICBnZXRJc0dpdCgpLFxuICAgIGdldFdvcmt0cmVlQ291bnQoKSxcbiAgICBnZXRHaEF1dGhTdGF0dXMoKSxcbiAgXSlcblxuICBsb2dFdmVudCgndGVuZ3Vfc3RhcnR1cF90ZWxlbWV0cnknLCB7XG4gICAgaXNfZ2l0OiBpc0dpdCxcbiAgICB3b3JrdHJlZV9jb3VudDogd29ya3RyZWVDb3VudCxcbiAgICBnaF9hdXRoX3N0YXR1czpcbiAgICAgIGdoQXV0aFN0YXR1cyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgIHNhbmRib3hfZW5hYmxlZDogU2FuZGJveE1hbmFnZXIuaXNTYW5kYm94aW5nRW5hYmxlZCgpLFxuICAgIGFyZV91bnNhbmRib3hlZF9jb21tYW5kc19hbGxvd2VkOlxuICAgICAgU2FuZGJveE1hbmFnZXIuYXJlVW5zYW5kYm94ZWRDb21tYW5kc0FsbG93ZWQoKSxcbiAgICBpc19hdXRvX2Jhc2hfYWxsb3dlZF9pZl9zYW5kYm94X2VuYWJsZWQ6XG4gICAgICBTYW5kYm94TWFuYWdlci5pc0F1dG9BbGxvd0Jhc2hJZlNhbmRib3hlZEVuYWJsZWQoKSxcbiAgICBhdXRvX3VwZGF0ZXJfZGlzYWJsZWQ6IGlzQXV0b1VwZGF0ZXJEaXNhYmxlZCgpLFxuICAgIHByZWZlcnNfcmVkdWNlZF9tb3Rpb246IGdldEluaXRpYWxTZXR0aW5ncygpLnByZWZlcnNSZWR1Y2VkTW90aW9uID8/IGZhbHNlLFxuICAgIC4uLmdldENlcnRFbnZWYXJUZWxlbWV0cnkoKSxcbiAgfSlcbn1cblxuLy8gQFtNT0RFTCBMQVVOQ0hdOiBDb25zaWRlciBhbnkgbWlncmF0aW9ucyB5b3UgbWF5IG5lZWQgZm9yIG1vZGVsIHN0cmluZ3MuIFNlZSBtaWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1LnRzIGZvciBhbiBleGFtcGxlLlxuLy8gQnVtcCB0aGlzIHdoZW4gYWRkaW5nIGEgbmV3IHN5bmMgbWlncmF0aW9uIHNvIGV4aXN0aW5nIHVzZXJzIHJlLXJ1biB0aGUgc2V0LlxuY29uc3QgQ1VSUkVOVF9NSUdSQVRJT05fVkVSU0lPTiA9IDExXG5mdW5jdGlvbiBydW5NaWdyYXRpb25zKCk6IHZvaWQge1xuICBpZiAoZ2V0R2xvYmFsQ29uZmlnKCkubWlncmF0aW9uVmVyc2lvbiAhPT0gQ1VSUkVOVF9NSUdSQVRJT05fVkVSU0lPTikge1xuICAgIG1pZ3JhdGVBdXRvVXBkYXRlc1RvU2V0dGluZ3MoKVxuICAgIG1pZ3JhdGVCeXBhc3NQZXJtaXNzaW9uc0FjY2VwdGVkVG9TZXR0aW5ncygpXG4gICAgbWlncmF0ZUVuYWJsZUFsbFByb2plY3RNY3BTZXJ2ZXJzVG9TZXR0aW5ncygpXG4gICAgcmVzZXRQcm9Ub09wdXNEZWZhdWx0KClcbiAgICBtaWdyYXRlU29ubmV0MW1Ub1Nvbm5ldDQ1KClcbiAgICBtaWdyYXRlTGVnYWN5T3B1c1RvQ3VycmVudCgpXG4gICAgbWlncmF0ZVNvbm5ldDQ1VG9Tb25uZXQ0NigpXG4gICAgbWlncmF0ZU9wdXNUb09wdXMxbSgpXG4gICAgbWlncmF0ZVJlcGxCcmlkZ2VFbmFibGVkVG9SZW1vdGVDb250cm9sQXRTdGFydHVwKClcbiAgICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICAgIHJlc2V0QXV0b01vZGVPcHRJbkZvckRlZmF1bHRPZmZlcigpXG4gICAgfVxuICAgIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgICBtaWdyYXRlRmVubmVjVG9PcHVzKClcbiAgICB9XG4gICAgc2F2ZUdsb2JhbENvbmZpZyhwcmV2ID0+XG4gICAgICBwcmV2Lm1pZ3JhdGlvblZlcnNpb24gPT09IENVUlJFTlRfTUlHUkFUSU9OX1ZFUlNJT05cbiAgICAgICAgPyBwcmV2XG4gICAgICAgIDogeyAuLi5wcmV2LCBtaWdyYXRpb25WZXJzaW9uOiBDVVJSRU5UX01JR1JBVElPTl9WRVJTSU9OIH0sXG4gICAgKVxuICB9XG4gIC8vIEFzeW5jIG1pZ3JhdGlvbiAtIGZpcmUgYW5kIGZvcmdldCBzaW5jZSBpdCdzIG5vbi1ibG9ja2luZ1xuICBtaWdyYXRlQ2hhbmdlbG9nRnJvbUNvbmZpZygpLmNhdGNoKCgpID0+IHtcbiAgICAvLyBTaWxlbnRseSBpZ25vcmUgbWlncmF0aW9uIGVycm9ycyAtIHdpbGwgcmV0cnkgb24gbmV4dCBzdGFydHVwXG4gIH0pXG59XG5cbi8qKlxuICogUHJlZmV0Y2ggc3lzdGVtIGNvbnRleHQgKGluY2x1ZGluZyBnaXQgc3RhdHVzKSBvbmx5IHdoZW4gaXQncyBzYWZlIHRvIGRvIHNvLlxuICogR2l0IGNvbW1hbmRzIGNhbiBleGVjdXRlIGFyYml0cmFyeSBjb2RlIHZpYSBob29rcyBhbmQgY29uZmlnIChlLmcuLCBjb3JlLmZzbW9uaXRvcixcbiAqIGRpZmYuZXh0ZXJuYWwpLCBzbyB3ZSBtdXN0IG9ubHkgcnVuIHRoZW0gYWZ0ZXIgdHJ1c3QgaXMgZXN0YWJsaXNoZWQgb3IgaW5cbiAqIG5vbi1pbnRlcmFjdGl2ZSBtb2RlIHdoZXJlIHRydXN0IGlzIGltcGxpY2l0LlxuICovXG5mdW5jdGlvbiBwcmVmZXRjaFN5c3RlbUNvbnRleHRJZlNhZmUoKTogdm9pZCB7XG4gIGNvbnN0IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uID0gZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24oKVxuXG4gIC8vIEluIG5vbi1pbnRlcmFjdGl2ZSBtb2RlICgtLXByaW50KSwgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kXG4gIC8vIGV4ZWN1dGlvbiBpcyBjb25zaWRlcmVkIHRydXN0ZWQgKGFzIGRvY3VtZW50ZWQgaW4gaGVscCB0ZXh0KVxuICBpZiAoaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24pIHtcbiAgICBsb2dGb3JEaWFnbm9zdGljc05vUElJKCdpbmZvJywgJ3ByZWZldGNoX3N5c3RlbV9jb250ZXh0X25vbl9pbnRlcmFjdGl2ZScpXG4gICAgdm9pZCBnZXRTeXN0ZW1Db250ZXh0KClcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIEluIGludGVyYWN0aXZlIG1vZGUsIG9ubHkgcHJlZmV0Y2ggaWYgdHJ1c3QgaGFzIGFscmVhZHkgYmVlbiBlc3RhYmxpc2hlZFxuICBjb25zdCBoYXNUcnVzdCA9IGNoZWNrSGFzVHJ1c3REaWFsb2dBY2NlcHRlZCgpXG4gIGlmIChoYXNUcnVzdCkge1xuICAgIGxvZ0ZvckRpYWdub3N0aWNzTm9QSUkoJ2luZm8nLCAncHJlZmV0Y2hfc3lzdGVtX2NvbnRleHRfaGFzX3RydXN0JylcbiAgICB2b2lkIGdldFN5c3RlbUNvbnRleHQoKVxuICB9IGVsc2Uge1xuICAgIGxvZ0ZvckRpYWdub3N0aWNzTm9QSUkoJ2luZm8nLCAncHJlZmV0Y2hfc3lzdGVtX2NvbnRleHRfc2tpcHBlZF9ub190cnVzdCcpXG4gIH1cbiAgLy8gT3RoZXJ3aXNlLCBkb24ndCBwcmVmZXRjaCAtIHdhaXQgZm9yIHRydXN0IHRvIGJlIGVzdGFibGlzaGVkIGZpcnN0XG59XG5cbi8qKlxuICogU3RhcnQgYmFja2dyb3VuZCBwcmVmZXRjaGVzIGFuZCBob3VzZWtlZXBpbmcgdGhhdCBhcmUgTk9UIG5lZWRlZCBiZWZvcmUgZmlyc3QgcmVuZGVyLlxuICogVGhlc2UgYXJlIGRlZmVycmVkIGZyb20gc2V0dXAoKSB0byByZWR1Y2UgZXZlbnQgbG9vcCBjb250ZW50aW9uIGFuZCBjaGlsZCBwcm9jZXNzXG4gKiBzcGF3bmluZyBkdXJpbmcgdGhlIGNyaXRpY2FsIHN0YXJ0dXAgcGF0aC5cbiAqIENhbGwgdGhpcyBhZnRlciB0aGUgUkVQTCBoYXMgYmVlbiByZW5kZXJlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzKCk6IHZvaWQge1xuICAvLyBUaGlzIGZ1bmN0aW9uIHJ1bnMgYWZ0ZXIgZmlyc3QgcmVuZGVyLCBzbyBpdCBkb2Vzbid0IGJsb2NrIHRoZSBpbml0aWFsIHBhaW50LlxuICAvLyBIb3dldmVyLCB0aGUgc3Bhd25lZCBwcm9jZXNzZXMgYW5kIGFzeW5jIHdvcmsgc3RpbGwgY29udGVuZCBmb3IgQ1BVIGFuZCBldmVudFxuICAvLyBsb29wIHRpbWUsIHdoaWNoIHNrZXdzIHN0YXJ0dXAgYmVuY2htYXJrcyAoQ1BVIHByb2ZpbGVzLCB0aW1lLXRvLWZpcnN0LXJlbmRlclxuICAvLyBtZWFzdXJlbWVudHMpLiBTa2lwIGFsbCBvZiBpdCB3aGVuIHdlJ3JlIG9ubHkgbWVhc3VyaW5nIHN0YXJ0dXAgcGVyZm9ybWFuY2UuXG4gIGlmIChcbiAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FWElUX0FGVEVSX0ZJUlNUX1JFTkRFUikgfHxcbiAgICAvLyAtLWJhcmU6IHNraXAgQUxMIHByZWZldGNoZXMuIFRoZXNlIGFyZSBjYWNoZS13YXJtcyBmb3IgdGhlIFJFUEwnc1xuICAgIC8vIGZpcnN0LXR1cm4gcmVzcG9uc2l2ZW5lc3MgKGluaXRVc2VyLCBnZXRVc2VyQ29udGV4dCwgdGlwcywgY291bnRGaWxlcyxcbiAgICAvLyBtb2RlbENhcGFiaWxpdGllcywgY2hhbmdlIGRldGVjdG9ycykuIFNjcmlwdGVkIC1wIGNhbGxzIGRvbid0IGhhdmUgYVxuICAgIC8vIFwidXNlciBpcyB0eXBpbmdcIiB3aW5kb3cgdG8gaGlkZSB0aGlzIHdvcmsgaW4gXHUyMDE0IGl0J3MgcHVyZSBvdmVyaGVhZCBvblxuICAgIC8vIHRoZSBjcml0aWNhbCBwYXRoLlxuICAgIGlzQmFyZU1vZGUoKVxuICApIHtcbiAgICByZXR1cm5cbiAgfVxuXG4gIC8vIFByb2Nlc3Mtc3Bhd25pbmcgcHJlZmV0Y2hlcyAoY29uc3VtZWQgYXQgZmlyc3QgQVBJIGNhbGwsIHVzZXIgaXMgc3RpbGwgdHlwaW5nKVxuICB2b2lkIGluaXRVc2VyKClcbiAgdm9pZCBnZXRVc2VyQ29udGV4dCgpXG4gIHByZWZldGNoU3lzdGVtQ29udGV4dElmU2FmZSgpXG4gIHZvaWQgZ2V0UmVsZXZhbnRUaXBzKClcbiAgaWYgKFxuICAgIGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1VTRV9CRURST0NLKSAmJlxuICAgICFpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9TS0lQX0JFRFJPQ0tfQVVUSClcbiAgKSB7XG4gICAgdm9pZCBwcmVmZXRjaEF3c0NyZWRlbnRpYWxzQW5kQmVkUm9ja0luZm9JZlNhZmUoKVxuICB9XG4gIGlmIChcbiAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9VU0VfVkVSVEVYKSAmJlxuICAgICFpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9TS0lQX1ZFUlRFWF9BVVRIKVxuICApIHtcbiAgICB2b2lkIHByZWZldGNoR2NwQ3JlZGVudGlhbHNJZlNhZmUoKVxuICB9XG4gIHZvaWQgY291bnRGaWxlc1JvdW5kZWRSZyhnZXRDd2QoKSwgQWJvcnRTaWduYWwudGltZW91dCgzMDAwKSwgW10pXG5cbiAgLy8gQW5hbHl0aWNzIGFuZCBmZWF0dXJlIGZsYWcgaW5pdGlhbGl6YXRpb25cbiAgdm9pZCBpbml0aWFsaXplQW5hbHl0aWNzR2F0ZXMoKVxuICB2b2lkIHByZWZldGNoT2ZmaWNpYWxNY3BVcmxzKClcblxuICB2b2lkIHJlZnJlc2hNb2RlbENhcGFiaWxpdGllcygpXG5cbiAgLy8gRmlsZSBjaGFuZ2UgZGV0ZWN0b3JzIGRlZmVycmVkIGZyb20gaW5pdCgpIHRvIHVuYmxvY2sgZmlyc3QgcmVuZGVyXG4gIHZvaWQgc2V0dGluZ3NDaGFuZ2VEZXRlY3Rvci5pbml0aWFsaXplKClcbiAgaWYgKCFpc0JhcmVNb2RlKCkpIHtcbiAgICB2b2lkIHNraWxsQ2hhbmdlRGV0ZWN0b3IuaW5pdGlhbGl6ZSgpXG4gIH1cblxuICAvLyBFdmVudCBsb29wIHN0YWxsIGRldGVjdG9yIFx1MjAxNCBsb2dzIHdoZW4gdGhlIG1haW4gdGhyZWFkIGlzIGJsb2NrZWQgPjUwMG1zXG4gIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgdm9pZCBpbXBvcnQoJy4vdXRpbHMvZXZlbnRMb29wU3RhbGxEZXRlY3Rvci5qcycpLnRoZW4obSA9PlxuICAgICAgbS5zdGFydEV2ZW50TG9vcFN0YWxsRGV0ZWN0b3IoKSxcbiAgICApXG4gIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNldHRpbmdzRnJvbUZsYWcoc2V0dGluZ3NGaWxlOiBzdHJpbmcpOiB2b2lkIHtcbiAgdHJ5IHtcbiAgICBjb25zdCB0cmltbWVkU2V0dGluZ3MgPSBzZXR0aW5nc0ZpbGUudHJpbSgpXG4gICAgY29uc3QgbG9va3NMaWtlSnNvbiA9XG4gICAgICB0cmltbWVkU2V0dGluZ3Muc3RhcnRzV2l0aCgneycpICYmIHRyaW1tZWRTZXR0aW5ncy5lbmRzV2l0aCgnfScpXG5cbiAgICBsZXQgc2V0dGluZ3NQYXRoOiBzdHJpbmdcblxuICAgIGlmIChsb29rc0xpa2VKc29uKSB7XG4gICAgICAvLyBJdCdzIGEgSlNPTiBzdHJpbmcgLSB2YWxpZGF0ZSBhbmQgY3JlYXRlIHRlbXAgZmlsZVxuICAgICAgY29uc3QgcGFyc2VkSnNvbiA9IHNhZmVQYXJzZUpTT04odHJpbW1lZFNldHRpbmdzKVxuICAgICAgaWYgKCFwYXJzZWRKc29uKSB7XG4gICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgIGNoYWxrLnJlZCgnRXJyb3I6IEludmFsaWQgSlNPTiBwcm92aWRlZCB0byAtLXNldHRpbmdzXFxuJyksXG4gICAgICAgIClcbiAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICB9XG5cbiAgICAgIC8vIENyZWF0ZSBhIHRlbXBvcmFyeSBmaWxlIGFuZCB3cml0ZSB0aGUgSlNPTiB0byBpdC5cbiAgICAgIC8vIFVzZSBhIGNvbnRlbnQtaGFzaC1iYXNlZCBwYXRoIGluc3RlYWQgb2YgcmFuZG9tIFVVSUQgdG8gYXZvaWRcbiAgICAgIC8vIGJ1c3RpbmcgdGhlIEFudGhyb3BpYyBBUEkgcHJvbXB0IGNhY2hlLiBUaGUgc2V0dGluZ3MgcGF0aCBlbmRzIHVwXG4gICAgICAvLyBpbiB0aGUgQmFzaCB0b29sJ3Mgc2FuZGJveCBkZW55V2l0aGluQWxsb3cgbGlzdCwgd2hpY2ggaXMgcGFydCBvZlxuICAgICAgLy8gdGhlIHRvb2wgZGVzY3JpcHRpb24gc2VudCB0byB0aGUgQVBJLiBBIHJhbmRvbSBVVUlEIHBlciBzdWJwcm9jZXNzXG4gICAgICAvLyBjaGFuZ2VzIHRoZSB0b29sIGRlc2NyaXB0aW9uIG9uIGV2ZXJ5IHF1ZXJ5KCkgY2FsbCwgaW52YWxpZGF0aW5nXG4gICAgICAvLyB0aGUgY2FjaGUgcHJlZml4IGFuZCBjYXVzaW5nIGEgMTJ4IGlucHV0IHRva2VuIGNvc3QgcGVuYWx0eS5cbiAgICAgIC8vIFRoZSBjb250ZW50IGhhc2ggZW5zdXJlcyBpZGVudGljYWwgc2V0dGluZ3MgcHJvZHVjZSB0aGUgc2FtZSBwYXRoXG4gICAgICAvLyBhY3Jvc3MgcHJvY2VzcyBib3VuZGFyaWVzIChlYWNoIFNESyBxdWVyeSgpIHNwYXducyBhIG5ldyBwcm9jZXNzKS5cbiAgICAgIHNldHRpbmdzUGF0aCA9IGdlbmVyYXRlVGVtcEZpbGVQYXRoKCdjbGF1ZGUtc2V0dGluZ3MnLCAnLmpzb24nLCB7XG4gICAgICAgIGNvbnRlbnRIYXNoOiB0cmltbWVkU2V0dGluZ3MsXG4gICAgICB9KVxuICAgICAgd3JpdGVGaWxlU3luY19ERVBSRUNBVEVEKHNldHRpbmdzUGF0aCwgdHJpbW1lZFNldHRpbmdzLCAndXRmOCcpXG4gICAgfSBlbHNlIHtcbiAgICAgIC8vIEl0J3MgYSBmaWxlIHBhdGggLSByZXNvbHZlIGFuZCB2YWxpZGF0ZSBieSBhdHRlbXB0aW5nIHRvIHJlYWRcbiAgICAgIGNvbnN0IHsgcmVzb2x2ZWRQYXRoOiByZXNvbHZlZFNldHRpbmdzUGF0aCB9ID0gc2FmZVJlc29sdmVQYXRoKFxuICAgICAgICBnZXRGc0ltcGxlbWVudGF0aW9uKCksXG4gICAgICAgIHNldHRpbmdzRmlsZSxcbiAgICAgIClcbiAgICAgIHRyeSB7XG4gICAgICAgIHJlYWRGaWxlU3luYyhyZXNvbHZlZFNldHRpbmdzUGF0aCwgJ3V0ZjgnKVxuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBpZiAoaXNFTk9FTlQoZSkpIHtcbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgYEVycm9yOiBTZXR0aW5ncyBmaWxlIG5vdCBmb3VuZDogJHtyZXNvbHZlZFNldHRpbmdzUGF0aH1cXG5gLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgICAgdGhyb3cgZVxuICAgICAgfVxuICAgICAgc2V0dGluZ3NQYXRoID0gcmVzb2x2ZWRTZXR0aW5nc1BhdGhcbiAgICB9XG5cbiAgICBzZXRGbGFnU2V0dGluZ3NQYXRoKHNldHRpbmdzUGF0aClcbiAgICByZXNldFNldHRpbmdzQ2FjaGUoKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICBsb2dFcnJvcihlcnJvcilcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBjaGFsay5yZWQoYEVycm9yIHByb2Nlc3Npbmcgc2V0dGluZ3M6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gKSxcbiAgICApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cblxuZnVuY3Rpb24gbG9hZFNldHRpbmdTb3VyY2VzRnJvbUZsYWcoc2V0dGluZ1NvdXJjZXNBcmc6IHN0cmluZyk6IHZvaWQge1xuICB0cnkge1xuICAgIGNvbnN0IHNvdXJjZXMgPSBwYXJzZVNldHRpbmdTb3VyY2VzRmxhZyhzZXR0aW5nU291cmNlc0FyZylcbiAgICBzZXRBbGxvd2VkU2V0dGluZ1NvdXJjZXMoc291cmNlcylcbiAgICByZXNldFNldHRpbmdzQ2FjaGUoKVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIEVycm9yKSB7XG4gICAgICBsb2dFcnJvcihlcnJvcilcbiAgICB9XG4gICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICBjaGFsay5yZWQoYEVycm9yIHByb2Nlc3NpbmcgLS1zZXR0aW5nLXNvdXJjZXM6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1cXG5gKSxcbiAgICApXG4gICAgcHJvY2Vzcy5leGl0KDEpXG4gIH1cbn1cblxuLyoqXG4gKiBQYXJzZSBhbmQgbG9hZCBzZXR0aW5ncyBmbGFncyBlYXJseSwgYmVmb3JlIGluaXQoKVxuICogVGhpcyBlbnN1cmVzIHNldHRpbmdzIGFyZSBmaWx0ZXJlZCBmcm9tIHRoZSBzdGFydCBvZiBpbml0aWFsaXphdGlvblxuICovXG5mdW5jdGlvbiBlYWdlckxvYWRTZXR0aW5ncygpOiB2b2lkIHtcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ2VhZ2VyTG9hZFNldHRpbmdzX3N0YXJ0JylcbiAgLy8gUGFyc2UgLS1zZXR0aW5ncyBmbGFnIGVhcmx5IHRvIGVuc3VyZSBzZXR0aW5ncyBhcmUgbG9hZGVkIGJlZm9yZSBpbml0KClcbiAgY29uc3Qgc2V0dGluZ3NGaWxlID0gZWFnZXJQYXJzZUNsaUZsYWcoJy0tc2V0dGluZ3MnKVxuICBpZiAoc2V0dGluZ3NGaWxlKSB7XG4gICAgbG9hZFNldHRpbmdzRnJvbUZsYWcoc2V0dGluZ3NGaWxlKVxuICB9XG5cbiAgLy8gUGFyc2UgLS1zZXR0aW5nLXNvdXJjZXMgZmxhZyBlYXJseSB0byBjb250cm9sIHdoaWNoIHNvdXJjZXMgYXJlIGxvYWRlZFxuICBjb25zdCBzZXR0aW5nU291cmNlc0FyZyA9IGVhZ2VyUGFyc2VDbGlGbGFnKCctLXNldHRpbmctc291cmNlcycpXG4gIGlmIChzZXR0aW5nU291cmNlc0FyZyAhPT0gdW5kZWZpbmVkKSB7XG4gICAgbG9hZFNldHRpbmdTb3VyY2VzRnJvbUZsYWcoc2V0dGluZ1NvdXJjZXNBcmcpXG4gIH1cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ2VhZ2VyTG9hZFNldHRpbmdzX2VuZCcpXG59XG5cbmZ1bmN0aW9uIGluaXRpYWxpemVFbnRyeXBvaW50KGlzTm9uSW50ZXJhY3RpdmU6IGJvb2xlYW4pOiB2b2lkIHtcbiAgLy8gU2tpcCBpZiBhbHJlYWR5IHNldCAoZS5nLiwgYnkgU0RLIG9yIG90aGVyIGVudHJ5cG9pbnRzKVxuICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCkge1xuICAgIHJldHVyblxuICB9XG5cbiAgY29uc3QgY2xpQXJncyA9IHByb2Nlc3MuYXJndi5zbGljZSgyKVxuXG4gIC8vIENoZWNrIGZvciBNQ1Agc2VydmUgY29tbWFuZCAoaGFuZGxlIGZsYWdzIGJlZm9yZSBtY3Agc2VydmUsIGUuZy4sIC0tZGVidWcgbWNwIHNlcnZlKVxuICBjb25zdCBtY3BJbmRleCA9IGNsaUFyZ3MuaW5kZXhPZignbWNwJylcbiAgaWYgKG1jcEluZGV4ICE9PSAtMSAmJiBjbGlBcmdzW21jcEluZGV4ICsgMV0gPT09ICdzZXJ2ZScpIHtcbiAgICBwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID0gJ21jcCdcbiAgICByZXR1cm5cbiAgfVxuXG4gIGlmIChpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9BQ1RJT04pKSB7XG4gICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCA9ICdjbGF1ZGUtY29kZS1naXRodWItYWN0aW9uJ1xuICAgIHJldHVyblxuICB9XG5cbiAgLy8gTm90ZTogJ2xvY2FsLWFnZW50JyBlbnRyeXBvaW50IGlzIHNldCBieSB0aGUgbG9jYWwgYWdlbnQgbW9kZSBsYXVuY2hlclxuICAvLyB2aWEgQ0xBVURFX0NPREVfRU5UUllQT0lOVCBlbnYgdmFyIChoYW5kbGVkIGJ5IGVhcmx5IHJldHVybiBhYm92ZSlcblxuICAvLyBTZXQgYmFzZWQgb24gaW50ZXJhY3RpdmUgc3RhdHVzXG4gIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPSBpc05vbkludGVyYWN0aXZlID8gJ3Nkay1jbGknIDogJ2NsaSdcbn1cblxuLy8gU2V0IGJ5IGVhcmx5IGFyZ3YgcHJvY2Vzc2luZyB3aGVuIGBjbGF1ZGUgb3BlbiA8dXJsPmAgaXMgZGV0ZWN0ZWQgKGludGVyYWN0aXZlIG1vZGUgb25seSlcbnR5cGUgUGVuZGluZ0Nvbm5lY3QgPSB7XG4gIHVybDogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGF1dGhUb2tlbjogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOiBib29sZWFuXG59XG5jb25zdCBfcGVuZGluZ0Nvbm5lY3Q6IFBlbmRpbmdDb25uZWN0IHwgdW5kZWZpbmVkID0gZmVhdHVyZSgnRElSRUNUX0NPTk5FQ1QnKVxuICA/IHsgdXJsOiB1bmRlZmluZWQsIGF1dGhUb2tlbjogdW5kZWZpbmVkLCBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczogZmFsc2UgfVxuICA6IHVuZGVmaW5lZFxuXG4vLyBTZXQgYnkgZWFybHkgYXJndiBwcm9jZXNzaW5nIHdoZW4gYGNsYXVkZSBhc3Npc3RhbnQgW3Nlc3Npb25JZF1gIGlzIGRldGVjdGVkXG50eXBlIFBlbmRpbmdBc3Npc3RhbnRDaGF0ID0geyBzZXNzaW9uSWQ/OiBzdHJpbmc7IGRpc2NvdmVyOiBib29sZWFuIH1cbmNvbnN0IF9wZW5kaW5nQXNzaXN0YW50Q2hhdDogUGVuZGluZ0Fzc2lzdGFudENoYXQgfCB1bmRlZmluZWQgPSBmZWF0dXJlKFxuICAnS0FJUk9TJyxcbilcbiAgPyB7IHNlc3Npb25JZDogdW5kZWZpbmVkLCBkaXNjb3ZlcjogZmFsc2UgfVxuICA6IHVuZGVmaW5lZFxuXG4vLyBgY2xhdWRlIHNzaCA8aG9zdD4gW2Rpcl1gIFx1MjAxNCBwYXJzZWQgZnJvbSBhcmd2IGVhcmx5IChzYW1lIHBhdHRlcm4gYXNcbi8vIERJUkVDVF9DT05ORUNUIGFib3ZlKSBzbyB0aGUgbWFpbiBjb21tYW5kIHBhdGggY2FuIHBpY2sgaXQgdXAgYW5kIGhhbmRcbi8vIHRoZSBSRVBMIGFuIFNTSC1iYWNrZWQgc2Vzc2lvbiBpbnN0ZWFkIG9mIGEgbG9jYWwgb25lLlxudHlwZSBQZW5kaW5nU1NIID0ge1xuICBob3N0OiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgY3dkOiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgcGVybWlzc2lvbk1vZGU6IHN0cmluZyB8IHVuZGVmaW5lZFxuICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczogYm9vbGVhblxuICAvKiogLS1sb2NhbDogc3Bhd24gdGhlIGNoaWxkIENMSSBkaXJlY3RseSwgc2tpcCBzc2gvcHJvYmUvZGVwbG95LiBlMmUgdGVzdCBtb2RlLiAqL1xuICBsb2NhbDogYm9vbGVhblxuICAvKiogRXh0cmEgQ0xJIGFyZ3MgdG8gZm9yd2FyZCB0byB0aGUgcmVtb3RlIENMSSBvbiBpbml0aWFsIHNwYXduICgtLXJlc3VtZSwgLWMpLiAqL1xuICBleHRyYUNsaUFyZ3M6IHN0cmluZ1tdXG59XG5jb25zdCBfcGVuZGluZ1NTSDogUGVuZGluZ1NTSCB8IHVuZGVmaW5lZCA9IGZlYXR1cmUoJ1NTSF9SRU1PVEUnKVxuICA/IHtcbiAgICAgIGhvc3Q6IHVuZGVmaW5lZCxcbiAgICAgIGN3ZDogdW5kZWZpbmVkLFxuICAgICAgcGVybWlzc2lvbk1vZGU6IHVuZGVmaW5lZCxcbiAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOiBmYWxzZSxcbiAgICAgIGxvY2FsOiBmYWxzZSxcbiAgICAgIGV4dHJhQ2xpQXJnczogW10sXG4gICAgfVxuICA6IHVuZGVmaW5lZFxuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gbWFpbigpIHtcbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fZnVuY3Rpb25fc3RhcnQnKVxuXG4gIC8vIFNFQ1VSSVRZOiBQcmV2ZW50IFdpbmRvd3MgZnJvbSBleGVjdXRpbmcgY29tbWFuZHMgZnJvbSBjdXJyZW50IGRpcmVjdG9yeVxuICAvLyBUaGlzIG11c3QgYmUgc2V0IGJlZm9yZSBBTlkgY29tbWFuZCBleGVjdXRpb24gdG8gcHJldmVudCBQQVRIIGhpamFja2luZyBhdHRhY2tzXG4gIC8vIFNlZTogaHR0cHM6Ly9kb2NzLm1pY3Jvc29mdC5jb20vZW4tdXMvd2luZG93cy93aW4zMi9hcGkvcHJvY2Vzc2Vudi9uZi1wcm9jZXNzZW52LXNlYXJjaHBhdGh3XG4gIHByb2Nlc3MuZW52Lk5vRGVmYXVsdEN1cnJlbnREaXJlY3RvcnlJbkV4ZVBhdGggPSAnMSdcblxuICAvLyBJbml0aWFsaXplIHdhcm5pbmcgaGFuZGxlciBlYXJseSB0byBjYXRjaCB3YXJuaW5nc1xuICBpbml0aWFsaXplV2FybmluZ0hhbmRsZXIoKVxuXG4gIHByb2Nlc3Mub24oJ2V4aXQnLCAoKSA9PiB7XG4gICAgcmVzZXRDdXJzb3IoKVxuICB9KVxuICBwcm9jZXNzLm9uKCdTSUdJTlQnLCAoKSA9PiB7XG4gICAgLy8gSW4gcHJpbnQgbW9kZSwgcHJpbnQudHMgcmVnaXN0ZXJzIGl0cyBvd24gU0lHSU5UIGhhbmRsZXIgdGhhdCBhYm9ydHNcbiAgICAvLyB0aGUgaW4tZmxpZ2h0IHF1ZXJ5IGFuZCBjYWxscyBncmFjZWZ1bFNodXRkb3duOyBza2lwIGhlcmUgdG8gYXZvaWRcbiAgICAvLyBwcmVlbXB0aW5nIGl0IHdpdGggYSBzeW5jaHJvbm91cyBwcm9jZXNzLmV4aXQoKS5cbiAgICBpZiAocHJvY2Vzcy5hcmd2LmluY2x1ZGVzKCctcCcpIHx8IHByb2Nlc3MuYXJndi5pbmNsdWRlcygnLS1wcmludCcpKSB7XG4gICAgICByZXR1cm5cbiAgICB9XG4gICAgcHJvY2Vzcy5leGl0KDApXG4gIH0pXG4gIHByb2ZpbGVDaGVja3BvaW50KCdtYWluX3dhcm5pbmdfaGFuZGxlcl9pbml0aWFsaXplZCcpXG5cbiAgLy8gQ2hlY2sgZm9yIGNjOi8vIG9yIGNjK3VuaXg6Ly8gVVJMIGluIGFyZ3YgXHUyMDE0IHJld3JpdGUgc28gdGhlIG1haW4gY29tbWFuZFxuICAvLyBoYW5kbGVzIGl0LCBnaXZpbmcgdGhlIGZ1bGwgaW50ZXJhY3RpdmUgVFVJIGluc3RlYWQgb2YgYSBzdHJpcHBlZC1kb3duIHN1YmNvbW1hbmQuXG4gIC8vIEZvciBoZWFkbGVzcyAoLXApLCB3ZSByZXdyaXRlIHRvIHRoZSBpbnRlcm5hbCBgb3BlbmAgc3ViY29tbWFuZC5cbiAgaWYgKGZlYXR1cmUoJ0RJUkVDVF9DT05ORUNUJykpIHtcbiAgICBjb25zdCByYXdDbGlBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgY29uc3QgY2NJZHggPSByYXdDbGlBcmdzLmZpbmRJbmRleChcbiAgICAgIGEgPT4gYS5zdGFydHNXaXRoKCdjYzovLycpIHx8IGEuc3RhcnRzV2l0aCgnY2MrdW5peDovLycpLFxuICAgIClcbiAgICBpZiAoY2NJZHggIT09IC0xICYmIF9wZW5kaW5nQ29ubmVjdCkge1xuICAgICAgY29uc3QgY2NVcmwgPSByYXdDbGlBcmdzW2NjSWR4XSFcbiAgICAgIGNvbnN0IHsgcGFyc2VDb25uZWN0VXJsIH0gPSBhd2FpdCBpbXBvcnQoJy4vc2VydmVyL3BhcnNlQ29ubmVjdFVybC5qcycpXG4gICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUNvbm5lY3RVcmwoY2NVcmwpXG4gICAgICBfcGVuZGluZ0Nvbm5lY3QuZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgPSByYXdDbGlBcmdzLmluY2x1ZGVzKFxuICAgICAgICAnLS1kYW5nZXJvdXNseS1za2lwLXBlcm1pc3Npb25zJyxcbiAgICAgIClcblxuICAgICAgaWYgKHJhd0NsaUFyZ3MuaW5jbHVkZXMoJy1wJykgfHwgcmF3Q2xpQXJncy5pbmNsdWRlcygnLS1wcmludCcpKSB7XG4gICAgICAgIC8vIEhlYWRsZXNzOiByZXdyaXRlIHRvIGludGVybmFsIGBvcGVuYCBzdWJjb21tYW5kXG4gICAgICAgIGNvbnN0IHN0cmlwcGVkID0gcmF3Q2xpQXJncy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGNjSWR4KVxuICAgICAgICBjb25zdCBkc3BJZHggPSBzdHJpcHBlZC5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgICBpZiAoZHNwSWR4ICE9PSAtMSkge1xuICAgICAgICAgIHN0cmlwcGVkLnNwbGljZShkc3BJZHgsIDEpXG4gICAgICAgIH1cbiAgICAgICAgcHJvY2Vzcy5hcmd2ID0gW1xuICAgICAgICAgIHByb2Nlc3MuYXJndlswXSEsXG4gICAgICAgICAgcHJvY2Vzcy5hcmd2WzFdISxcbiAgICAgICAgICAnb3BlbicsXG4gICAgICAgICAgY2NVcmwsXG4gICAgICAgICAgLi4uc3RyaXBwZWQsXG4gICAgICAgIF1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIEludGVyYWN0aXZlOiBzdHJpcCBjYzovLyBVUkwgYW5kIGZsYWdzLCBydW4gbWFpbiBjb21tYW5kXG4gICAgICAgIF9wZW5kaW5nQ29ubmVjdC51cmwgPSBwYXJzZWQuc2VydmVyVXJsXG4gICAgICAgIF9wZW5kaW5nQ29ubmVjdC5hdXRoVG9rZW4gPSBwYXJzZWQuYXV0aFRva2VuXG4gICAgICAgIGNvbnN0IHN0cmlwcGVkID0gcmF3Q2xpQXJncy5maWx0ZXIoKF8sIGkpID0+IGkgIT09IGNjSWR4KVxuICAgICAgICBjb25zdCBkc3BJZHggPSBzdHJpcHBlZC5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgICBpZiAoZHNwSWR4ICE9PSAtMSkge1xuICAgICAgICAgIHN0cmlwcGVkLnNwbGljZShkc3BJZHgsIDEpXG4gICAgICAgIH1cbiAgICAgICAgcHJvY2Vzcy5hcmd2ID0gW3Byb2Nlc3MuYXJndlswXSEsIHByb2Nlc3MuYXJndlsxXSEsIC4uLnN0cmlwcGVkXVxuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIC8vIEhhbmRsZSBkZWVwIGxpbmsgVVJJcyBlYXJseSBcdTIwMTQgdGhpcyBpcyBpbnZva2VkIGJ5IHRoZSBPUyBwcm90b2NvbCBoYW5kbGVyXG4gIC8vIGFuZCBzaG91bGQgYmFpbCBvdXQgYmVmb3JlIGZ1bGwgaW5pdCBzaW5jZSBpdCBvbmx5IG5lZWRzIHRvIHBhcnNlIHRoZSBVUklcbiAgLy8gYW5kIG9wZW4gYSB0ZXJtaW5hbC5cbiAgaWYgKGZlYXR1cmUoJ0xPREVTVE9ORScpKSB7XG4gICAgY29uc3QgaGFuZGxlVXJpSWR4ID0gcHJvY2Vzcy5hcmd2LmluZGV4T2YoJy0taGFuZGxlLXVyaScpXG4gICAgaWYgKGhhbmRsZVVyaUlkeCAhPT0gLTEgJiYgcHJvY2Vzcy5hcmd2W2hhbmRsZVVyaUlkeCArIDFdKSB7XG4gICAgICBjb25zdCB7IGVuYWJsZUNvbmZpZ3MgfSA9IGF3YWl0IGltcG9ydCgnLi91dGlscy9jb25maWcuanMnKVxuICAgICAgZW5hYmxlQ29uZmlncygpXG4gICAgICBjb25zdCB1cmkgPSBwcm9jZXNzLmFyZ3ZbaGFuZGxlVXJpSWR4ICsgMV0hXG4gICAgICBjb25zdCB7IGhhbmRsZURlZXBMaW5rVXJpIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICcuL3V0aWxzL2RlZXBMaW5rL3Byb3RvY29sSGFuZGxlci5qcydcbiAgICAgIClcbiAgICAgIGNvbnN0IGV4aXRDb2RlID0gYXdhaXQgaGFuZGxlRGVlcExpbmtVcmkodXJpKVxuICAgICAgcHJvY2Vzcy5leGl0KGV4aXRDb2RlKVxuICAgIH1cblxuICAgIC8vIG1hY09TIFVSTCBoYW5kbGVyOiB3aGVuIExhdW5jaFNlcnZpY2VzIGxhdW5jaGVzIG91ciAuYXBwIGJ1bmRsZSwgdGhlXG4gICAgLy8gVVJMIGFycml2ZXMgdmlhIEFwcGxlIEV2ZW50IChub3QgYXJndikuIExhdW5jaFNlcnZpY2VzIG92ZXJ3cml0ZXNcbiAgICAvLyBfX0NGQnVuZGxlSWRlbnRpZmllciB0byB0aGUgbGF1bmNoaW5nIGJ1bmRsZSdzIElELCB3aGljaCBpcyBhIHByZWNpc2VcbiAgICAvLyBwb3NpdGl2ZSBzaWduYWwgXHUyMDE0IGNoZWFwZXIgdGhhbiBpbXBvcnRpbmcgYW5kIGd1ZXNzaW5nIHdpdGggaGV1cmlzdGljcy5cbiAgICBpZiAoXG4gICAgICBwcm9jZXNzLnBsYXRmb3JtID09PSAnZGFyd2luJyAmJlxuICAgICAgcHJvY2Vzcy5lbnYuX19DRkJ1bmRsZUlkZW50aWZpZXIgPT09XG4gICAgICAgICdjb20uYW50aHJvcGljLmNsYXVkZS1jb2RlLXVybC1oYW5kbGVyJ1xuICAgICkge1xuICAgICAgY29uc3QgeyBlbmFibGVDb25maWdzIH0gPSBhd2FpdCBpbXBvcnQoJy4vdXRpbHMvY29uZmlnLmpzJylcbiAgICAgIGVuYWJsZUNvbmZpZ3MoKVxuICAgICAgY29uc3QgeyBoYW5kbGVVcmxTY2hlbWVMYXVuY2ggfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vdXRpbHMvZGVlcExpbmsvcHJvdG9jb2xIYW5kbGVyLmpzJ1xuICAgICAgKVxuICAgICAgY29uc3QgdXJsU2NoZW1lUmVzdWx0ID0gYXdhaXQgaGFuZGxlVXJsU2NoZW1lTGF1bmNoKClcbiAgICAgIHByb2Nlc3MuZXhpdCh1cmxTY2hlbWVSZXN1bHQgPz8gMSlcbiAgICB9XG4gIH1cblxuICAvLyBgY2xhdWRlIGFzc2lzdGFudCBbc2Vzc2lvbklkXWAgXHUyMDE0IHN0YXNoIGFuZCBzdHJpcCBzbyB0aGUgbWFpblxuICAvLyBjb21tYW5kIGhhbmRsZXMgaXQsIGdpdmluZyB0aGUgZnVsbCBpbnRlcmFjdGl2ZSBUVUkuIFBvc2l0aW9uLTAgb25seVxuICAvLyAobWF0Y2hpbmcgdGhlIHNzaCBwYXR0ZXJuIGJlbG93KSBcdTIwMTQgaW5kZXhPZiB3b3VsZCBmYWxzZS1wb3NpdGl2ZSBvblxuICAvLyBgY2xhdWRlIC1wIFwiZXhwbGFpbiBhc3Npc3RhbnRcImAuIFJvb3QtZmxhZy1iZWZvcmUtc3ViY29tbWFuZFxuICAvLyAoZS5nLiBgLS1kZWJ1ZyBhc3Npc3RhbnRgKSBmYWxscyB0aHJvdWdoIHRvIHRoZSBzdHViLCB3aGljaFxuICAvLyBwcmludHMgdXNhZ2UuXG4gIGlmIChmZWF0dXJlKCdLQUlST1MnKSAmJiBfcGVuZGluZ0Fzc2lzdGFudENoYXQpIHtcbiAgICBjb25zdCByYXdBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgaWYgKHJhd0FyZ3NbMF0gPT09ICdhc3Npc3RhbnQnKSB7XG4gICAgICBjb25zdCBuZXh0QXJnID0gcmF3QXJnc1sxXVxuICAgICAgaWYgKG5leHRBcmcgJiYgIW5leHRBcmcuc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgICAgIF9wZW5kaW5nQXNzaXN0YW50Q2hhdC5zZXNzaW9uSWQgPSBuZXh0QXJnXG4gICAgICAgIHJhd0FyZ3Muc3BsaWNlKDAsIDIpIC8vIGRyb3AgJ2Fzc2lzdGFudCcgYW5kIHNlc3Npb25JZFxuICAgICAgICBwcm9jZXNzLmFyZ3YgPSBbcHJvY2Vzcy5hcmd2WzBdISwgcHJvY2Vzcy5hcmd2WzFdISwgLi4ucmF3QXJnc11cbiAgICAgIH0gZWxzZSBpZiAoIW5leHRBcmcpIHtcbiAgICAgICAgX3BlbmRpbmdBc3Npc3RhbnRDaGF0LmRpc2NvdmVyID0gdHJ1ZVxuICAgICAgICByYXdBcmdzLnNwbGljZSgwLCAxKSAvLyBkcm9wICdhc3Npc3RhbnQnXG4gICAgICAgIHByb2Nlc3MuYXJndiA9IFtwcm9jZXNzLmFyZ3ZbMF0hLCBwcm9jZXNzLmFyZ3ZbMV0hLCAuLi5yYXdBcmdzXVxuICAgICAgfVxuICAgICAgLy8gZWxzZTogYGNsYXVkZSBhc3Npc3RhbnQgLS1oZWxwYCBcdTIxOTIgZmFsbCB0aHJvdWdoIHRvIHN0dWJcbiAgICB9XG4gIH1cblxuICAvLyBgY2xhdWRlIHNzaCA8aG9zdD4gW2Rpcl1gIFx1MjAxNCBzdHJpcCBmcm9tIGFyZ3Ygc28gdGhlIG1haW4gY29tbWFuZCBoYW5kbGVyXG4gIC8vIHJ1bnMgKGZ1bGwgaW50ZXJhY3RpdmUgVFVJKSwgc3Rhc2ggdGhlIGhvc3QvZGlyIGZvciB0aGUgUkVQTCBicmFuY2ggYXRcbiAgLy8gfmxpbmUgMzcyMCB0byBwaWNrIHVwLiBIZWFkbGVzcyAoLXApIG1vZGUgbm90IHN1cHBvcnRlZCBpbiB2MTogU1NIXG4gIC8vIHNlc3Npb25zIG5lZWQgdGhlIGxvY2FsIFJFUEwgdG8gZHJpdmUgdGhlbSAoaW50ZXJydXB0LCBwZXJtaXNzaW9ucykuXG4gIGlmIChmZWF0dXJlKCdTU0hfUkVNT1RFJykgJiYgX3BlbmRpbmdTU0gpIHtcbiAgICBjb25zdCByYXdDbGlBcmdzID0gcHJvY2Vzcy5hcmd2LnNsaWNlKDIpXG4gICAgLy8gU1NILXNwZWNpZmljIGZsYWdzIGNhbiBhcHBlYXIgYmVmb3JlIHRoZSBob3N0IHBvc2l0aW9uYWwgKGUuZy5cbiAgICAvLyBgc3NoIC0tcGVybWlzc2lvbi1tb2RlIGF1dG8gaG9zdCAvdG1wYCBcdTIwMTQgc3RhbmRhcmQgUE9TSVggZmxhZ3MtYmVmb3JlLVxuICAgIC8vIHBvc2l0aW9uYWxzKS4gUHVsbCB0aGVtIGFsbCBvdXQgQkVGT1JFIGNoZWNraW5nIHdoZXRoZXIgYSBob3N0IHdhc1xuICAgIC8vIGdpdmVuLCBzbyBgY2xhdWRlIHNzaCAtLXBlcm1pc3Npb24tbW9kZSBhdXRvIGhvc3RgIGFuZCBgY2xhdWRlIHNzaCBob3N0XG4gICAgLy8gLS1wZXJtaXNzaW9uLW1vZGUgYXV0b2AgYXJlIGVxdWl2YWxlbnQuIFRoZSBob3N0IGNoZWNrIGJlbG93IG9ubHkgbmVlZHNcbiAgICAvLyB0byBndWFyZCBhZ2FpbnN0IGAtaGAvYC0taGVscGAgKHdoaWNoIGNvbW1hbmRlciBzaG91bGQgaGFuZGxlKS5cbiAgICBpZiAocmF3Q2xpQXJnc1swXSA9PT0gJ3NzaCcpIHtcbiAgICAgIGNvbnN0IGxvY2FsSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLWxvY2FsJylcbiAgICAgIGlmIChsb2NhbElkeCAhPT0gLTEpIHtcbiAgICAgICAgX3BlbmRpbmdTU0gubG9jYWwgPSB0cnVlXG4gICAgICAgIHJhd0NsaUFyZ3Muc3BsaWNlKGxvY2FsSWR4LCAxKVxuICAgICAgfVxuICAgICAgY29uc3QgZHNwSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnKVxuICAgICAgaWYgKGRzcElkeCAhPT0gLTEpIHtcbiAgICAgICAgX3BlbmRpbmdTU0guZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgPSB0cnVlXG4gICAgICAgIHJhd0NsaUFyZ3Muc3BsaWNlKGRzcElkeCwgMSlcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBtSWR4ID0gcmF3Q2xpQXJncy5pbmRleE9mKCctLXBlcm1pc3Npb24tbW9kZScpXG4gICAgICBpZiAoXG4gICAgICAgIHBtSWR4ICE9PSAtMSAmJlxuICAgICAgICByYXdDbGlBcmdzW3BtSWR4ICsgMV0gJiZcbiAgICAgICAgIXJhd0NsaUFyZ3NbcG1JZHggKyAxXSEuc3RhcnRzV2l0aCgnLScpXG4gICAgICApIHtcbiAgICAgICAgX3BlbmRpbmdTU0gucGVybWlzc2lvbk1vZGUgPSByYXdDbGlBcmdzW3BtSWR4ICsgMV1cbiAgICAgICAgcmF3Q2xpQXJncy5zcGxpY2UocG1JZHgsIDIpXG4gICAgICB9XG4gICAgICBjb25zdCBwbUVxSWR4ID0gcmF3Q2xpQXJncy5maW5kSW5kZXgoYSA9PlxuICAgICAgICBhLnN0YXJ0c1dpdGgoJy0tcGVybWlzc2lvbi1tb2RlPScpLFxuICAgICAgKVxuICAgICAgaWYgKHBtRXFJZHggIT09IC0xKSB7XG4gICAgICAgIF9wZW5kaW5nU1NILnBlcm1pc3Npb25Nb2RlID0gcmF3Q2xpQXJnc1twbUVxSWR4XSEuc3BsaXQoJz0nKVsxXVxuICAgICAgICByYXdDbGlBcmdzLnNwbGljZShwbUVxSWR4LCAxKVxuICAgICAgfVxuICAgICAgLy8gRm9yd2FyZCBzZXNzaW9uLXJlc3VtZSArIG1vZGVsIGZsYWdzIHRvIHRoZSByZW1vdGUgQ0xJJ3MgaW5pdGlhbCBzcGF3bi5cbiAgICAgIC8vIC0tY29udGludWUvLWMgYW5kIC0tcmVzdW1lIDx1dWlkPiBvcGVyYXRlIG9uIHRoZSBSRU1PVEUgc2Vzc2lvbiBoaXN0b3J5XG4gICAgICAvLyAod2hpY2ggcGVyc2lzdHMgdW5kZXIgdGhlIHJlbW90ZSdzIH4vLmNsYXVkZS9wcm9qZWN0cy88Y3dkPi8pLlxuICAgICAgLy8gLS1tb2RlbCBjb250cm9scyB3aGljaCBtb2RlbCB0aGUgcmVtb3RlIHVzZXMuXG4gICAgICBjb25zdCBleHRyYWN0RmxhZyA9IChcbiAgICAgICAgZmxhZzogc3RyaW5nLFxuICAgICAgICBvcHRzOiB7IGhhc1ZhbHVlPzogYm9vbGVhbjsgYXM/OiBzdHJpbmcgfSA9IHt9LFxuICAgICAgKSA9PiB7XG4gICAgICAgIGNvbnN0IGkgPSByYXdDbGlBcmdzLmluZGV4T2YoZmxhZylcbiAgICAgICAgaWYgKGkgIT09IC0xKSB7XG4gICAgICAgICAgX3BlbmRpbmdTU0guZXh0cmFDbGlBcmdzLnB1c2gob3B0cy5hcyA/PyBmbGFnKVxuICAgICAgICAgIGNvbnN0IHZhbCA9IHJhd0NsaUFyZ3NbaSArIDFdXG4gICAgICAgICAgaWYgKG9wdHMuaGFzVmFsdWUgJiYgdmFsICYmICF2YWwuc3RhcnRzV2l0aCgnLScpKSB7XG4gICAgICAgICAgICBfcGVuZGluZ1NTSC5leHRyYUNsaUFyZ3MucHVzaCh2YWwpXG4gICAgICAgICAgICByYXdDbGlBcmdzLnNwbGljZShpLCAyKVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByYXdDbGlBcmdzLnNwbGljZShpLCAxKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBjb25zdCBlcUkgPSByYXdDbGlBcmdzLmZpbmRJbmRleChhID0+IGEuc3RhcnRzV2l0aChgJHtmbGFnfT1gKSlcbiAgICAgICAgaWYgKGVxSSAhPT0gLTEpIHtcbiAgICAgICAgICBfcGVuZGluZ1NTSC5leHRyYUNsaUFyZ3MucHVzaChcbiAgICAgICAgICAgIG9wdHMuYXMgPz8gZmxhZyxcbiAgICAgICAgICAgIHJhd0NsaUFyZ3NbZXFJXSEuc2xpY2UoZmxhZy5sZW5ndGggKyAxKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcmF3Q2xpQXJncy5zcGxpY2UoZXFJLCAxKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICBleHRyYWN0RmxhZygnLWMnLCB7IGFzOiAnLS1jb250aW51ZScgfSlcbiAgICAgIGV4dHJhY3RGbGFnKCctLWNvbnRpbnVlJylcbiAgICAgIGV4dHJhY3RGbGFnKCctLXJlc3VtZScsIHsgaGFzVmFsdWU6IHRydWUgfSlcbiAgICAgIGV4dHJhY3RGbGFnKCctLW1vZGVsJywgeyBoYXNWYWx1ZTogdHJ1ZSB9KVxuICAgIH1cbiAgICAvLyBBZnRlciBwcmUtZXh0cmFjdGlvbiwgYW55IHJlbWFpbmluZyBkYXNoLWFyZyBhdCBbMV0gaXMgZWl0aGVyIC1oLy0taGVscFxuICAgIC8vIChjb21tYW5kZXIgaGFuZGxlcykgb3IgYW4gdW5rbm93bi10by1zc2ggZmxhZyAoZmFsbCB0aHJvdWdoIHRvIGNvbW1hbmRlclxuICAgIC8vIHNvIGl0IHN1cmZhY2VzIGEgcHJvcGVyIGVycm9yKS4gT25seSBhIG5vbi1kYXNoIGFyZyBpcyB0aGUgaG9zdC5cbiAgICBpZiAoXG4gICAgICByYXdDbGlBcmdzWzBdID09PSAnc3NoJyAmJlxuICAgICAgcmF3Q2xpQXJnc1sxXSAmJlxuICAgICAgIXJhd0NsaUFyZ3NbMV0uc3RhcnRzV2l0aCgnLScpXG4gICAgKSB7XG4gICAgICBfcGVuZGluZ1NTSC5ob3N0ID0gcmF3Q2xpQXJnc1sxXVxuICAgICAgLy8gT3B0aW9uYWwgcG9zaXRpb25hbCBjd2QuXG4gICAgICBsZXQgY29uc3VtZWQgPSAyXG4gICAgICBpZiAocmF3Q2xpQXJnc1syXSAmJiAhcmF3Q2xpQXJnc1syXS5zdGFydHNXaXRoKCctJykpIHtcbiAgICAgICAgX3BlbmRpbmdTU0guY3dkID0gcmF3Q2xpQXJnc1syXVxuICAgICAgICBjb25zdW1lZCA9IDNcbiAgICAgIH1cbiAgICAgIGNvbnN0IHJlc3QgPSByYXdDbGlBcmdzLnNsaWNlKGNvbnN1bWVkKVxuXG4gICAgICAvLyBIZWFkbGVzcyAoLXApIG1vZGUgaXMgbm90IHN1cHBvcnRlZCB3aXRoIFNTSCBpbiB2MSBcdTIwMTQgcmVqZWN0IGVhcmx5XG4gICAgICAvLyBzbyB0aGUgZmxhZyBkb2Vzbid0IHNpbGVudGx5IGNhdXNlIGxvY2FsIGV4ZWN1dGlvbi5cbiAgICAgIGlmIChyZXN0LmluY2x1ZGVzKCctcCcpIHx8IHJlc3QuaW5jbHVkZXMoJy0tcHJpbnQnKSkge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAnRXJyb3I6IGhlYWRsZXNzICgtcC8tLXByaW50KSBtb2RlIGlzIG5vdCBzdXBwb3J0ZWQgd2l0aCBjbGF1ZGUgc3NoXFxuJyxcbiAgICAgICAgKVxuICAgICAgICBncmFjZWZ1bFNodXRkb3duU3luYygxKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgLy8gUmV3cml0ZSBhcmd2IHNvIHRoZSBtYWluIGNvbW1hbmQgc2VlcyByZW1haW5pbmcgZmxhZ3MgYnV0IG5vdCBgc3NoYC5cbiAgICAgIHByb2Nlc3MuYXJndiA9IFtwcm9jZXNzLmFyZ3ZbMF0hLCBwcm9jZXNzLmFyZ3ZbMV0hLCAuLi5yZXN0XVxuICAgIH1cbiAgfVxuXG4gIC8vIENoZWNrIGZvciAtcC8tLXByaW50IGFuZCAtLWluaXQtb25seSBmbGFncyBlYXJseSB0byBzZXQgaXNJbnRlcmFjdGl2ZVNlc3Npb24gYmVmb3JlIGluaXQoKVxuICAvLyBUaGlzIGlzIG5lZWRlZCBiZWNhdXNlIHRlbGVtZXRyeSBpbml0aWFsaXphdGlvbiBjYWxscyBhdXRoIGZ1bmN0aW9ucyB0aGF0IG5lZWQgdGhpcyBmbGFnXG4gIGNvbnN0IGNsaUFyZ3MgPSBwcm9jZXNzLmFyZ3Yuc2xpY2UoMilcbiAgY29uc3QgaGFzUHJpbnRGbGFnID0gY2xpQXJncy5pbmNsdWRlcygnLXAnKSB8fCBjbGlBcmdzLmluY2x1ZGVzKCctLXByaW50JylcbiAgY29uc3QgaGFzSW5pdE9ubHlGbGFnID0gY2xpQXJncy5pbmNsdWRlcygnLS1pbml0LW9ubHknKVxuICBjb25zdCBoYXNTZGtVcmwgPSBjbGlBcmdzLnNvbWUoYXJnID0+IGFyZy5zdGFydHNXaXRoKCctLXNkay11cmwnKSlcbiAgY29uc3QgaXNOb25JbnRlcmFjdGl2ZSA9XG4gICAgaGFzUHJpbnRGbGFnIHx8IGhhc0luaXRPbmx5RmxhZyB8fCBoYXNTZGtVcmwgfHwgIXByb2Nlc3Muc3Rkb3V0LmlzVFRZXG5cbiAgLy8gU3RvcCBjYXB0dXJpbmcgZWFybHkgaW5wdXQgZm9yIG5vbi1pbnRlcmFjdGl2ZSBtb2Rlc1xuICBpZiAoaXNOb25JbnRlcmFjdGl2ZSkge1xuICAgIHN0b3BDYXB0dXJpbmdFYXJseUlucHV0KClcbiAgfVxuXG4gIC8vIFNldCBzaW1wbGlmaWVkIHRyYWNraW5nIGZpZWxkc1xuICBjb25zdCBpc0ludGVyYWN0aXZlID0gIWlzTm9uSW50ZXJhY3RpdmVcbiAgc2V0SXNJbnRlcmFjdGl2ZShpc0ludGVyYWN0aXZlKVxuXG4gIC8vIEluaXRpYWxpemUgZW50cnlwb2ludCBiYXNlZCBvbiBtb2RlIC0gbmVlZHMgdG8gYmUgc2V0IGJlZm9yZSBhbnkgZXZlbnQgaXMgbG9nZ2VkXG4gIGluaXRpYWxpemVFbnRyeXBvaW50KGlzTm9uSW50ZXJhY3RpdmUpXG5cbiAgLy8gRGV0ZXJtaW5lIGNsaWVudCB0eXBlXG4gIGNvbnN0IGNsaWVudFR5cGUgPSAoKCkgPT4ge1xuICAgIGlmIChpc0VudlRydXRoeShwcm9jZXNzLmVudi5HSVRIVUJfQUNUSU9OUykpIHJldHVybiAnZ2l0aHViLWFjdGlvbidcbiAgICBpZiAocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRU5UUllQT0lOVCA9PT0gJ3Nkay10cycpIHJldHVybiAnc2RrLXR5cGVzY3JpcHQnXG4gICAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPT09ICdzZGstcHknKSByZXR1cm4gJ3Nkay1weXRob24nXG4gICAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPT09ICdzZGstY2xpJykgcmV0dXJuICdzZGstY2xpJ1xuICAgIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAnY2xhdWRlLXZzY29kZScpXG4gICAgICByZXR1cm4gJ2NsYXVkZS12c2NvZGUnXG4gICAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPT09ICdsb2NhbC1hZ2VudCcpXG4gICAgICByZXR1cm4gJ2xvY2FsLWFnZW50J1xuICAgIGlmIChwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9FTlRSWVBPSU5UID09PSAnY2xhdWRlLWRlc2t0b3AnKVxuICAgICAgcmV0dXJuICdjbGF1ZGUtZGVza3RvcCdcblxuICAgIC8vIENoZWNrIGlmIHNlc3Npb24taW5ncmVzcyB0b2tlbiBpcyBwcm92aWRlZCAoaW5kaWNhdGVzIHJlbW90ZSBzZXNzaW9uKVxuICAgIGNvbnN0IGhhc1Nlc3Npb25JbmdyZXNzVG9rZW4gPVxuICAgICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfU0VTU0lPTl9BQ0NFU1NfVE9LRU4gfHxcbiAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1dFQlNPQ0tFVF9BVVRIX0ZJTEVfREVTQ1JJUFRPUlxuICAgIGlmIChcbiAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgPT09ICdyZW1vdGUnIHx8XG4gICAgICBoYXNTZXNzaW9uSW5ncmVzc1Rva2VuXG4gICAgKSB7XG4gICAgICByZXR1cm4gJ3JlbW90ZSdcbiAgICB9XG5cbiAgICByZXR1cm4gJ2NsaSdcbiAgfSkoKVxuICBzZXRDbGllbnRUeXBlKGNsaWVudFR5cGUpXG5cbiAgY29uc3QgcHJldmlld0Zvcm1hdCA9IHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1FVRVNUSU9OX1BSRVZJRVdfRk9STUFUXG4gIGlmIChwcmV2aWV3Rm9ybWF0ID09PSAnbWFya2Rvd24nIHx8IHByZXZpZXdGb3JtYXQgPT09ICdodG1sJykge1xuICAgIHNldFF1ZXN0aW9uUHJldmlld0Zvcm1hdChwcmV2aWV3Rm9ybWF0KVxuICB9IGVsc2UgaWYgKFxuICAgICFjbGllbnRUeXBlLnN0YXJ0c1dpdGgoJ3Nkay0nKSAmJlxuICAgIC8vIERlc2t0b3AgYW5kIENDUiBwYXNzIHByZXZpZXdGb3JtYXQgdmlhIHRvb2xDb25maWc7IHdoZW4gdGhlIGZlYXR1cmUgaXNcbiAgICAvLyBnYXRlZCBvZmYgdGhleSBwYXNzIHVuZGVmaW5lZCBcdTIwMTQgZG9uJ3Qgb3ZlcnJpZGUgdGhhdCB3aXRoIG1hcmtkb3duLlxuICAgIGNsaWVudFR5cGUgIT09ICdjbGF1ZGUtZGVza3RvcCcgJiZcbiAgICBjbGllbnRUeXBlICE9PSAnbG9jYWwtYWdlbnQnICYmXG4gICAgY2xpZW50VHlwZSAhPT0gJ3JlbW90ZSdcbiAgKSB7XG4gICAgc2V0UXVlc3Rpb25QcmV2aWV3Rm9ybWF0KCdtYXJrZG93bicpXG4gIH1cblxuICAvLyBUYWcgc2Vzc2lvbnMgY3JlYXRlZCB2aWEgYGNsYXVkZSByZW1vdGUtY29udHJvbGAgc28gdGhlIGJhY2tlbmQgY2FuIGlkZW50aWZ5IHRoZW1cbiAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVklST05NRU5UX0tJTkQgPT09ICdicmlkZ2UnKSB7XG4gICAgc2V0U2Vzc2lvblNvdXJjZSgncmVtb3RlLWNvbnRyb2wnKVxuICB9XG5cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ21haW5fY2xpZW50X3R5cGVfZGV0ZXJtaW5lZCcpXG5cbiAgLy8gUGFyc2UgYW5kIGxvYWQgc2V0dGluZ3MgZmxhZ3MgZWFybHksIGJlZm9yZSBpbml0KClcbiAgZWFnZXJMb2FkU2V0dGluZ3MoKVxuXG4gIHByb2ZpbGVDaGVja3BvaW50KCdtYWluX2JlZm9yZV9ydW4nKVxuXG4gIGF3YWl0IHJ1bigpXG4gIHByb2ZpbGVDaGVja3BvaW50KCdtYWluX2FmdGVyX3J1bicpXG59XG5cbmFzeW5jIGZ1bmN0aW9uIGdldElucHV0UHJvbXB0KFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgaW5wdXRGb3JtYXQ6ICd0ZXh0JyB8ICdzdHJlYW0tanNvbicsXG4pOiBQcm9taXNlPHN0cmluZyB8IEFzeW5jSXRlcmFibGU8c3RyaW5nPj4ge1xuICBpZiAoXG4gICAgIXByb2Nlc3Muc3RkaW4uaXNUVFkgJiZcbiAgICAvLyBJbnB1dCBoaWphY2tpbmcgYnJlYWtzIE1DUC5cbiAgICAhcHJvY2Vzcy5hcmd2LmluY2x1ZGVzKCdtY3AnKVxuICApIHtcbiAgICBpZiAoaW5wdXRGb3JtYXQgPT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgIHJldHVybiBwcm9jZXNzLnN0ZGluXG4gICAgfVxuICAgIHByb2Nlc3Muc3RkaW4uc2V0RW5jb2RpbmcoJ3V0ZjgnKVxuICAgIGxldCBkYXRhID0gJydcbiAgICBjb25zdCBvbkRhdGEgPSAoY2h1bms6IHN0cmluZykgPT4ge1xuICAgICAgZGF0YSArPSBjaHVua1xuICAgIH1cbiAgICBwcm9jZXNzLnN0ZGluLm9uKCdkYXRhJywgb25EYXRhKVxuICAgIC8vIElmIG5vIGRhdGEgYXJyaXZlcyBpbiAzcywgc3RvcCB3YWl0aW5nIGFuZCB3YXJuLiBTdGRpbiBpcyBsaWtlbHkgYW5cbiAgICAvLyBpbmhlcml0ZWQgcGlwZSBmcm9tIGEgcGFyZW50IHRoYXQgaXNuJ3Qgd3JpdGluZyAoc3VicHJvY2VzcyBzcGF3bmVkXG4gICAgLy8gd2l0aG91dCBleHBsaWNpdCBzdGRpbiBoYW5kbGluZykuIDNzIGNvdmVycyBzbG93IHByb2R1Y2VycyBsaWtlIGN1cmwsXG4gICAgLy8ganEgb24gbGFyZ2UgZmlsZXMsIHB5dGhvbiB3aXRoIGltcG9ydCBvdmVyaGVhZC4gVGhlIHdhcm5pbmcgbWFrZXNcbiAgICAvLyBzaWxlbnQgZGF0YSBsb3NzIHZpc2libGUgZm9yIHRoZSByYXJlIHByb2R1Y2VyIHRoYXQncyBzbG93ZXIgc3RpbGwuXG4gICAgY29uc3QgdGltZWRPdXQgPSBhd2FpdCBwZWVrRm9yU3RkaW5EYXRhKHByb2Nlc3Muc3RkaW4sIDMwMDApXG4gICAgcHJvY2Vzcy5zdGRpbi5vZmYoJ2RhdGEnLCBvbkRhdGEpXG4gICAgaWYgKHRpbWVkT3V0KSB7XG4gICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgJ1dhcm5pbmc6IG5vIHN0ZGluIGRhdGEgcmVjZWl2ZWQgaW4gM3MsIHByb2NlZWRpbmcgd2l0aG91dCBpdC4gJyArXG4gICAgICAgICAgJ0lmIHBpcGluZyBmcm9tIGEgc2xvdyBjb21tYW5kLCByZWRpcmVjdCBzdGRpbiBleHBsaWNpdGx5OiA8IC9kZXYvbnVsbCB0byBza2lwLCBvciB3YWl0IGxvbmdlci5cXG4nLFxuICAgICAgKVxuICAgIH1cbiAgICByZXR1cm4gW3Byb21wdCwgZGF0YV0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJ1xcbicpXG4gIH1cbiAgcmV0dXJuIHByb21wdFxufVxuXG5hc3luYyBmdW5jdGlvbiBydW4oKTogUHJvbWlzZTxDb21tYW5kZXJDb21tYW5kPiB7XG4gIHByb2ZpbGVDaGVja3BvaW50KCdydW5fZnVuY3Rpb25fc3RhcnQnKVxuXG4gIC8vIENyZWF0ZSBoZWxwIGNvbmZpZyB0aGF0IHNvcnRzIG9wdGlvbnMgYnkgbG9uZyBvcHRpb24gbmFtZS5cbiAgLy8gQ29tbWFuZGVyIHN1cHBvcnRzIGNvbXBhcmVPcHRpb25zIGF0IHJ1bnRpbWUgYnV0IEBjb21tYW5kZXItanMvZXh0cmEtdHlwaW5nc1xuICAvLyBkb2Vzbid0IGluY2x1ZGUgaXQgaW4gdGhlIHR5cGUgZGVmaW5pdGlvbnMsIHNvIHdlIHVzZSBPYmplY3QuYXNzaWduIHRvIGFkZCBpdC5cbiAgZnVuY3Rpb24gY3JlYXRlU29ydGVkSGVscENvbmZpZygpOiB7XG4gICAgc29ydFN1YmNvbW1hbmRzOiB0cnVlXG4gICAgc29ydE9wdGlvbnM6IHRydWVcbiAgfSB7XG4gICAgY29uc3QgZ2V0T3B0aW9uU29ydEtleSA9IChvcHQ6IE9wdGlvbik6IHN0cmluZyA9PlxuICAgICAgb3B0Lmxvbmc/LnJlcGxhY2UoL14tLS8sICcnKSA/PyBvcHQuc2hvcnQ/LnJlcGxhY2UoL14tLywgJycpID8/ICcnXG4gICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oXG4gICAgICB7IHNvcnRTdWJjb21tYW5kczogdHJ1ZSwgc29ydE9wdGlvbnM6IHRydWUgfSBhcyBjb25zdCxcbiAgICAgIHtcbiAgICAgICAgY29tcGFyZU9wdGlvbnM6IChhOiBPcHRpb24sIGI6IE9wdGlvbikgPT5cbiAgICAgICAgICBnZXRPcHRpb25Tb3J0S2V5KGEpLmxvY2FsZUNvbXBhcmUoZ2V0T3B0aW9uU29ydEtleShiKSksXG4gICAgICB9LFxuICAgIClcbiAgfVxuICBjb25zdCBwcm9ncmFtID0gbmV3IENvbW1hbmRlckNvbW1hbmQoKVxuICAgIC5jb25maWd1cmVIZWxwKGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKSlcbiAgICAuZW5hYmxlUG9zaXRpb25hbE9wdGlvbnMoKVxuICBwcm9maWxlQ2hlY2twb2ludCgncnVuX2NvbW1hbmRlcl9pbml0aWFsaXplZCcpXG5cbiAgLy8gVXNlIHByZUFjdGlvbiBob29rIHRvIHJ1biBpbml0aWFsaXphdGlvbiBvbmx5IHdoZW4gZXhlY3V0aW5nIGEgY29tbWFuZCxcbiAgLy8gbm90IHdoZW4gZGlzcGxheWluZyBoZWxwLiBUaGlzIGF2b2lkcyB0aGUgbmVlZCBmb3IgZW52IHZhcmlhYmxlIHNpZ25hbGluZy5cbiAgcHJvZ3JhbS5ob29rKCdwcmVBY3Rpb24nLCBhc3luYyB0aGlzQ29tbWFuZCA9PiB7XG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9zdGFydCcpXG4gICAgLy8gQXdhaXQgYXN5bmMgc3VicHJvY2VzcyBsb2FkcyBzdGFydGVkIGF0IG1vZHVsZSBldmFsdWF0aW9uIChsaW5lcyAxMi0yMCkuXG4gICAgLy8gTmVhcmx5IGZyZWUgXHUyMDE0IHN1YnByb2Nlc3NlcyBjb21wbGV0ZSBkdXJpbmcgdGhlIH4xMzVtcyBvZiBpbXBvcnRzIGFib3ZlLlxuICAgIC8vIE11c3QgcmVzb2x2ZSBiZWZvcmUgaW5pdCgpIHdoaWNoIHRyaWdnZXJzIHRoZSBmaXJzdCBzZXR0aW5ncyByZWFkXG4gICAgLy8gKGFwcGx5U2FmZUNvbmZpZ0Vudmlyb25tZW50VmFyaWFibGVzIFx1MjE5MiBnZXRTZXR0aW5nc0ZvclNvdXJjZSgncG9saWN5U2V0dGluZ3MnKVxuICAgIC8vIFx1MjE5MiBpc1JlbW90ZU1hbmFnZWRTZXR0aW5nc0VsaWdpYmxlIFx1MjE5MiBzeW5jIGtleWNoYWluIHJlYWRzIG90aGVyd2lzZSB+NjVtcykuXG4gICAgYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgZW5zdXJlTWRtU2V0dGluZ3NMb2FkZWQoKSxcbiAgICAgIGVuc3VyZUtleWNoYWluUHJlZmV0Y2hDb21wbGV0ZWQoKSxcbiAgICBdKVxuICAgIHByb2ZpbGVDaGVja3BvaW50KCdwcmVBY3Rpb25fYWZ0ZXJfbWRtJylcbiAgICBhd2FpdCBpbml0KClcbiAgICBwcm9maWxlQ2hlY2twb2ludCgncHJlQWN0aW9uX2FmdGVyX2luaXQnKVxuXG4gICAgLy8gcHJvY2Vzcy50aXRsZSBvbiBXaW5kb3dzIHNldHMgdGhlIGNvbnNvbGUgdGl0bGUgZGlyZWN0bHk7IG9uIFBPU0lYLFxuICAgIC8vIHRlcm1pbmFsIHNoZWxsIGludGVncmF0aW9uIG1heSBtaXJyb3IgdGhlIHByb2Nlc3MgbmFtZSB0byB0aGUgdGFiLlxuICAgIC8vIEFmdGVyIGluaXQoKSBzbyBzZXR0aW5ncy5qc29uIGVudiBjYW4gYWxzbyBnYXRlIHRoaXMgKGdoLTQ3NjUpLlxuICAgIGlmICghaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfRElTQUJMRV9URVJNSU5BTF9USVRMRSkpIHtcbiAgICAgIHByb2Nlc3MudGl0bGUgPSAnY2xhdWRlJ1xuICAgIH1cblxuICAgIC8vIEF0dGFjaCBsb2dnaW5nIHNpbmtzIHNvIHN1YmNvbW1hbmQgaGFuZGxlcnMgY2FuIHVzZSBsb2dFdmVudC9sb2dFcnJvci5cbiAgICAvLyBCZWZvcmUgUFIgIzExMTA2IGxvZ0V2ZW50IGRpc3BhdGNoZWQgZGlyZWN0bHk7IGFmdGVyLCBldmVudHMgcXVldWUgdW50aWxcbiAgICAvLyBhIHNpbmsgYXR0YWNoZXMuIHNldHVwKCkgYXR0YWNoZXMgc2lua3MgZm9yIHRoZSBkZWZhdWx0IGNvbW1hbmQsIGJ1dFxuICAgIC8vIHN1YmNvbW1hbmRzIChkb2N0b3IsIG1jcCwgcGx1Z2luLCBhdXRoKSBuZXZlciBjYWxsIHNldHVwKCkgYW5kIHdvdWxkXG4gICAgLy8gc2lsZW50bHkgZHJvcCBldmVudHMgb24gcHJvY2Vzcy5leGl0KCkuIEJvdGggaW5pdHMgYXJlIGlkZW1wb3RlbnQuXG4gICAgY29uc3QgeyBpbml0U2lua3MgfSA9IGF3YWl0IGltcG9ydCgnLi91dGlscy9zaW5rcy5qcycpXG4gICAgaW5pdFNpbmtzKClcbiAgICBwcm9maWxlQ2hlY2twb2ludCgncHJlQWN0aW9uX2FmdGVyX3NpbmtzJylcblxuICAgIC8vIGdoLTMzNTA4OiAtLXBsdWdpbi1kaXIgaXMgYSB0b3AtbGV2ZWwgcHJvZ3JhbSBvcHRpb24uIFRoZSBkZWZhdWx0XG4gICAgLy8gYWN0aW9uIHJlYWRzIGl0IGZyb20gaXRzIG93biBvcHRpb25zIGRlc3RydWN0dXJlLCBidXQgc3ViY29tbWFuZHNcbiAgICAvLyAocGx1Z2luIGxpc3QsIHBsdWdpbiBpbnN0YWxsLCBtY3AgKikgaGF2ZSB0aGVpciBvd24gYWN0aW9ucyBhbmRcbiAgICAvLyBuZXZlciBzZWUgaXQuIFdpcmUgaXQgdXAgaGVyZSBzbyBnZXRJbmxpbmVQbHVnaW5zKCkgd29ya3MgZXZlcnl3aGVyZS5cbiAgICAvLyB0aGlzQ29tbWFuZC5vcHRzKCkgaXMgdHlwZWQge30gaGVyZSBiZWNhdXNlIHRoaXMgaG9vayBpcyBhdHRhY2hlZFxuICAgIC8vIGJlZm9yZSAub3B0aW9uKCctLXBsdWdpbi1kaXInLCAuLi4pIGluIHRoZSBjaGFpbiBcdTIwMTQgZXh0cmEtdHlwaW5nc1xuICAgIC8vIGJ1aWxkcyB0aGUgdHlwZSBhcyBvcHRpb25zIGFyZSBhZGRlZC4gTmFycm93IHdpdGggYSBydW50aW1lIGd1YXJkO1xuICAgIC8vIHRoZSBjb2xsZWN0IGFjY3VtdWxhdG9yICsgW10gZGVmYXVsdCBndWFyYW50ZWUgc3RyaW5nW10gaW4gcHJhY3RpY2UuXG4gICAgY29uc3QgcGx1Z2luRGlyID0gdGhpc0NvbW1hbmQuZ2V0T3B0aW9uVmFsdWUoJ3BsdWdpbkRpcicpXG4gICAgaWYgKFxuICAgICAgQXJyYXkuaXNBcnJheShwbHVnaW5EaXIpICYmXG4gICAgICBwbHVnaW5EaXIubGVuZ3RoID4gMCAmJlxuICAgICAgcGx1Z2luRGlyLmV2ZXJ5KHAgPT4gdHlwZW9mIHAgPT09ICdzdHJpbmcnKVxuICAgICkge1xuICAgICAgc2V0SW5saW5lUGx1Z2lucyhwbHVnaW5EaXIpXG4gICAgICBjbGVhclBsdWdpbkNhY2hlKCdwcmVBY3Rpb246IC0tcGx1Z2luLWRpciBpbmxpbmUgcGx1Z2lucycpXG4gICAgfVxuXG4gICAgcnVuTWlncmF0aW9ucygpXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9hZnRlcl9taWdyYXRpb25zJylcblxuICAgIC8vIExvYWQgcmVtb3RlIG1hbmFnZWQgc2V0dGluZ3MgZm9yIGVudGVycHJpc2UgY3VzdG9tZXJzIChub24tYmxvY2tpbmcpXG4gICAgLy8gRmFpbHMgb3BlbiAtIGlmIGZldGNoIGZhaWxzLCBjb250aW51ZXMgd2l0aG91dCByZW1vdGUgc2V0dGluZ3NcbiAgICAvLyBTZXR0aW5ncyBhcmUgYXBwbGllZCB2aWEgaG90LXJlbG9hZCB3aGVuIHRoZXkgYXJyaXZlXG4gICAgLy8gTXVzdCBoYXBwZW4gYWZ0ZXIgaW5pdCgpIHRvIGVuc3VyZSBjb25maWcgcmVhZGluZyBpcyBhbGxvd2VkXG4gICAgdm9pZCBsb2FkUmVtb3RlTWFuYWdlZFNldHRpbmdzKClcbiAgICB2b2lkIGxvYWRQb2xpY3lMaW1pdHMoKVxuXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9hZnRlcl9yZW1vdGVfc2V0dGluZ3MnKVxuXG4gICAgLy8gTG9hZCBzZXR0aW5ncyBzeW5jIChub24tYmxvY2tpbmcsIGZhaWwtb3BlbilcbiAgICAvLyBDTEk6IHVwbG9hZHMgbG9jYWwgc2V0dGluZ3MgdG8gcmVtb3RlIChDQ1IgZG93bmxvYWQgaXMgaGFuZGxlZCBieSBwcmludC50cylcbiAgICBpZiAoZmVhdHVyZSgnVVBMT0FEX1VTRVJfU0VUVElOR1MnKSkge1xuICAgICAgdm9pZCBpbXBvcnQoJy4vc2VydmljZXMvc2V0dGluZ3NTeW5jL2luZGV4LmpzJykudGhlbihtID0+XG4gICAgICAgIG0udXBsb2FkVXNlclNldHRpbmdzSW5CYWNrZ3JvdW5kKCksXG4gICAgICApXG4gICAgfVxuXG4gICAgcHJvZmlsZUNoZWNrcG9pbnQoJ3ByZUFjdGlvbl9hZnRlcl9zZXR0aW5nc19zeW5jJylcbiAgfSlcblxuICBwcm9ncmFtXG4gICAgLm5hbWUoJ2NsYXVkZScpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgYENsYXVkZSBDb2RlIC0gc3RhcnRzIGFuIGludGVyYWN0aXZlIHNlc3Npb24gYnkgZGVmYXVsdCwgdXNlIC1wLy0tcHJpbnQgZm9yIG5vbi1pbnRlcmFjdGl2ZSBvdXRwdXRgLFxuICAgIClcbiAgICAuYXJndW1lbnQoJ1twcm9tcHRdJywgJ1lvdXIgcHJvbXB0JywgU3RyaW5nKVxuICAgIC8vIFN1YmNvbW1hbmRzIGluaGVyaXQgaGVscE9wdGlvbiB2aWEgY29tbWFuZGVyJ3MgY29weUluaGVyaXRlZFNldHRpbmdzIFx1MjAxNFxuICAgIC8vIHNldHRpbmcgaXQgb25jZSBoZXJlIGNvdmVycyBtY3AsIHBsdWdpbiwgYXV0aCwgYW5kIGFsbCBvdGhlciBzdWJjb21tYW5kcy5cbiAgICAuaGVscE9wdGlvbignLWgsIC0taGVscCcsICdEaXNwbGF5IGhlbHAgZm9yIGNvbW1hbmQnKVxuICAgIC5vcHRpb24oXG4gICAgICAnLWQsIC0tZGVidWcgW2ZpbHRlcl0nLFxuICAgICAgJ0VuYWJsZSBkZWJ1ZyBtb2RlIHdpdGggb3B0aW9uYWwgY2F0ZWdvcnkgZmlsdGVyaW5nIChlLmcuLCBcImFwaSxob29rc1wiIG9yIFwiITFwLCFmaWxlXCIpJyxcbiAgICAgIChfdmFsdWU6IHN0cmluZyB8IHRydWUpID0+IHtcbiAgICAgICAgLy8gSWYgdmFsdWUgaXMgcHJvdmlkZWQsIGl0IHdpbGwgYmUgdGhlIGZpbHRlciBzdHJpbmdcbiAgICAgICAgLy8gSWYgbm90IHByb3ZpZGVkIGJ1dCBmbGFnIGlzIHByZXNlbnQsIHZhbHVlIHdpbGwgYmUgdHJ1ZVxuICAgICAgICAvLyBUaGUgYWN0dWFsIGZpbHRlcmluZyBpcyBoYW5kbGVkIGluIGRlYnVnLnRzIGJ5IHBhcnNpbmcgcHJvY2Vzcy5hcmd2XG4gICAgICAgIHJldHVybiB0cnVlXG4gICAgICB9LFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbignLWQyZSwgLS1kZWJ1Zy10by1zdGRlcnInLCAnRW5hYmxlIGRlYnVnIG1vZGUgKHRvIHN0ZGVyciknKVxuICAgICAgICAuYXJnUGFyc2VyKEJvb2xlYW4pXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tZGVidWctZmlsZSA8cGF0aD4nLFxuICAgICAgJ1dyaXRlIGRlYnVnIGxvZ3MgdG8gYSBzcGVjaWZpYyBmaWxlIHBhdGggKGltcGxpY2l0bHkgZW5hYmxlcyBkZWJ1ZyBtb2RlKScsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tdmVyYm9zZScsXG4gICAgICAnT3ZlcnJpZGUgdmVyYm9zZSBtb2RlIHNldHRpbmcgZnJvbSBjb25maWcnLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctcCwgLS1wcmludCcsXG4gICAgICAnUHJpbnQgcmVzcG9uc2UgYW5kIGV4aXQgKHVzZWZ1bCBmb3IgcGlwZXMpLiBOb3RlOiBUaGUgd29ya3NwYWNlIHRydXN0IGRpYWxvZyBpcyBza2lwcGVkIHdoZW4gQ2xhdWRlIGlzIHJ1biB3aXRoIHRoZSAtcCBtb2RlLiBPbmx5IHVzZSB0aGlzIGZsYWcgaW4gZGlyZWN0b3JpZXMgeW91IHRydXN0LicsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYmFyZScsXG4gICAgICAnTWluaW1hbCBtb2RlOiBza2lwIGhvb2tzLCBMU1AsIHBsdWdpbiBzeW5jLCBhdHRyaWJ1dGlvbiwgYXV0by1tZW1vcnksIGJhY2tncm91bmQgcHJlZmV0Y2hlcywga2V5Y2hhaW4gcmVhZHMsIGFuZCBDTEFVREUubWQgYXV0by1kaXNjb3ZlcnkuIFNldHMgQ0xBVURFX0NPREVfU0lNUExFPTEuIEFudGhyb3BpYyBhdXRoIGlzIHN0cmljdGx5IEFOVEhST1BJQ19BUElfS0VZIG9yIGFwaUtleUhlbHBlciB2aWEgLS1zZXR0aW5ncyAoT0F1dGggYW5kIGtleWNoYWluIGFyZSBuZXZlciByZWFkKS4gM1AgcHJvdmlkZXJzIChCZWRyb2NrL1ZlcnRleC9Gb3VuZHJ5KSB1c2UgdGhlaXIgb3duIGNyZWRlbnRpYWxzLiBTa2lsbHMgc3RpbGwgcmVzb2x2ZSB2aWEgL3NraWxsLW5hbWUuIEV4cGxpY2l0bHkgcHJvdmlkZSBjb250ZXh0IHZpYTogLS1zeXN0ZW0tcHJvbXB0Wy1maWxlXSwgLS1hcHBlbmQtc3lzdGVtLXByb21wdFstZmlsZV0sIC0tYWRkLWRpciAoQ0xBVURFLm1kIGRpcnMpLCAtLW1jcC1jb25maWcsIC0tc2V0dGluZ3MsIC0tYWdlbnRzLCAtLXBsdWdpbi1kaXIuJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1pbml0JyxcbiAgICAgICAgJ1J1biBTZXR1cCBob29rcyB3aXRoIGluaXQgdHJpZ2dlciwgdGhlbiBjb250aW51ZScsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1pbml0LW9ubHknLFxuICAgICAgICAnUnVuIFNldHVwIGFuZCBTZXNzaW9uU3RhcnQ6c3RhcnR1cCBob29rcywgdGhlbiBleGl0JyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLW1haW50ZW5hbmNlJyxcbiAgICAgICAgJ1J1biBTZXR1cCBob29rcyB3aXRoIG1haW50ZW5hbmNlIHRyaWdnZXIsIHRoZW4gY29udGludWUnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tb3V0cHV0LWZvcm1hdCA8Zm9ybWF0PicsXG4gICAgICAgICdPdXRwdXQgZm9ybWF0IChvbmx5IHdvcmtzIHdpdGggLS1wcmludCk6IFwidGV4dFwiIChkZWZhdWx0KSwgXCJqc29uXCIgKHNpbmdsZSByZXN1bHQpLCBvciBcInN0cmVhbS1qc29uXCIgKHJlYWx0aW1lIHN0cmVhbWluZyknLFxuICAgICAgKS5jaG9pY2VzKFsndGV4dCcsICdqc29uJywgJ3N0cmVhbS1qc29uJ10pLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tanNvbi1zY2hlbWEgPHNjaGVtYT4nLFxuICAgICAgICAnSlNPTiBTY2hlbWEgZm9yIHN0cnVjdHVyZWQgb3V0cHV0IHZhbGlkYXRpb24uICcgK1xuICAgICAgICAgICdFeGFtcGxlOiB7XCJ0eXBlXCI6XCJvYmplY3RcIixcInByb3BlcnRpZXNcIjp7XCJuYW1lXCI6e1widHlwZVwiOlwic3RyaW5nXCJ9fSxcInJlcXVpcmVkXCI6W1wibmFtZVwiXX0nLFxuICAgICAgKS5hcmdQYXJzZXIoU3RyaW5nKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWluY2x1ZGUtaG9vay1ldmVudHMnLFxuICAgICAgJ0luY2x1ZGUgYWxsIGhvb2sgbGlmZWN5Y2xlIGV2ZW50cyBpbiB0aGUgb3V0cHV0IHN0cmVhbSAob25seSB3b3JrcyB3aXRoIC0tb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbiknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWluY2x1ZGUtcGFydGlhbC1tZXNzYWdlcycsXG4gICAgICAnSW5jbHVkZSBwYXJ0aWFsIG1lc3NhZ2UgY2h1bmtzIGFzIHRoZXkgYXJyaXZlIChvbmx5IHdvcmtzIHdpdGggLS1wcmludCBhbmQgLS1vdXRwdXQtZm9ybWF0PXN0cmVhbS1qc29uKScsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0taW5wdXQtZm9ybWF0IDxmb3JtYXQ+JyxcbiAgICAgICAgJ0lucHV0IGZvcm1hdCAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpOiBcInRleHRcIiAoZGVmYXVsdCksIG9yIFwic3RyZWFtLWpzb25cIiAocmVhbHRpbWUgc3RyZWFtaW5nIGlucHV0KScsXG4gICAgICApLmNob2ljZXMoWyd0ZXh0JywgJ3N0cmVhbS1qc29uJ10pLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tbWNwLWRlYnVnJyxcbiAgICAgICdbREVQUkVDQVRFRC4gVXNlIC0tZGVidWcgaW5zdGVhZF0gRW5hYmxlIE1DUCBkZWJ1ZyBtb2RlIChzaG93cyBNQ1Agc2VydmVyIGVycm9ycyknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnLFxuICAgICAgJ0J5cGFzcyBhbGwgcGVybWlzc2lvbiBjaGVja3MuIFJlY29tbWVuZGVkIG9ubHkgZm9yIHNhbmRib3hlcyB3aXRoIG5vIGludGVybmV0IGFjY2Vzcy4nLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWFsbG93LWRhbmdlcm91c2x5LXNraXAtcGVybWlzc2lvbnMnLFxuICAgICAgJ0VuYWJsZSBieXBhc3NpbmcgYWxsIHBlcm1pc3Npb24gY2hlY2tzIGFzIGFuIG9wdGlvbiwgd2l0aG91dCBpdCBiZWluZyBlbmFibGVkIGJ5IGRlZmF1bHQuIFJlY29tbWVuZGVkIG9ubHkgZm9yIHNhbmRib3hlcyB3aXRoIG5vIGludGVybmV0IGFjY2Vzcy4nLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXRoaW5raW5nIDxtb2RlPicsXG4gICAgICAgICdUaGlua2luZyBtb2RlOiBlbmFibGVkIChlcXVpdmFsZW50IHRvIGFkYXB0aXZlKSwgZGlzYWJsZWQnLFxuICAgICAgKVxuICAgICAgICAuY2hvaWNlcyhbJ2VuYWJsZWQnLCAnYWRhcHRpdmUnLCAnZGlzYWJsZWQnXSlcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1tYXgtdGhpbmtpbmctdG9rZW5zIDx0b2tlbnM+JyxcbiAgICAgICAgJ1tERVBSRUNBVEVELiBVc2UgLS10aGlua2luZyBpbnN0ZWFkIGZvciBuZXdlciBtb2RlbHNdIE1heGltdW0gbnVtYmVyIG9mIHRoaW5raW5nIHRva2VucyAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpJyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcihOdW1iZXIpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tbWF4LXR1cm5zIDx0dXJucz4nLFxuICAgICAgICAnTWF4aW11bSBudW1iZXIgb2YgYWdlbnRpYyB0dXJucyBpbiBub24taW50ZXJhY3RpdmUgbW9kZS4gVGhpcyB3aWxsIGVhcmx5IGV4aXQgdGhlIGNvbnZlcnNhdGlvbiBhZnRlciB0aGUgc3BlY2lmaWVkIG51bWJlciBvZiB0dXJucy4gKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoTnVtYmVyKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLW1heC1idWRnZXQtdXNkIDxhbW91bnQ+JyxcbiAgICAgICAgJ01heGltdW0gZG9sbGFyIGFtb3VudCB0byBzcGVuZCBvbiBBUEkgY2FsbHMgKG9ubHkgd29ya3Mgd2l0aCAtLXByaW50KScsXG4gICAgICApLmFyZ1BhcnNlcih2YWx1ZSA9PiB7XG4gICAgICAgIGNvbnN0IGFtb3VudCA9IE51bWJlcih2YWx1ZSlcbiAgICAgICAgaWYgKGlzTmFOKGFtb3VudCkgfHwgYW1vdW50IDw9IDApIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgICAnLS1tYXgtYnVkZ2V0LXVzZCBtdXN0IGJlIGEgcG9zaXRpdmUgbnVtYmVyIGdyZWF0ZXIgdGhhbiAwJyxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGFtb3VudFxuICAgICAgfSksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS10YXNrLWJ1ZGdldCA8dG9rZW5zPicsXG4gICAgICAgICdBUEktc2lkZSB0YXNrIGJ1ZGdldCBpbiB0b2tlbnMgKG91dHB1dF9jb25maWcudGFza19idWRnZXQpJyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcih2YWx1ZSA9PiB7XG4gICAgICAgICAgY29uc3QgdG9rZW5zID0gTnVtYmVyKHZhbHVlKVxuICAgICAgICAgIGlmIChpc05hTih0b2tlbnMpIHx8IHRva2VucyA8PSAwIHx8ICFOdW1iZXIuaXNJbnRlZ2VyKHRva2VucykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignLS10YXNrLWJ1ZGdldCBtdXN0IGJlIGEgcG9zaXRpdmUgaW50ZWdlcicpXG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiB0b2tlbnNcbiAgICAgICAgfSlcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1yZXBsYXktdXNlci1tZXNzYWdlcycsXG4gICAgICAnUmUtZW1pdCB1c2VyIG1lc3NhZ2VzIGZyb20gc3RkaW4gYmFjayBvbiBzdGRvdXQgZm9yIGFja25vd2xlZGdtZW50IChvbmx5IHdvcmtzIHdpdGggLS1pbnB1dC1mb3JtYXQ9c3RyZWFtLWpzb24gYW5kIC0tb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbiknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWVuYWJsZS1hdXRoLXN0YXR1cycsXG4gICAgICAgICdFbmFibGUgYXV0aCBzdGF0dXMgbWVzc2FnZXMgaW4gU0RLIG1vZGUnLFxuICAgICAgKVxuICAgICAgICAuZGVmYXVsdChmYWxzZSlcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1hbGxvd2VkVG9vbHMsIC0tYWxsb3dlZC10b29scyA8dG9vbHMuLi4+JyxcbiAgICAgICdDb21tYSBvciBzcGFjZS1zZXBhcmF0ZWQgbGlzdCBvZiB0b29sIG5hbWVzIHRvIGFsbG93IChlLmcuIFwiQmFzaChnaXQ6KikgRWRpdFwiKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS10b29scyA8dG9vbHMuLi4+JyxcbiAgICAgICdTcGVjaWZ5IHRoZSBsaXN0IG9mIGF2YWlsYWJsZSB0b29scyBmcm9tIHRoZSBidWlsdC1pbiBzZXQuIFVzZSBcIlwiIHRvIGRpc2FibGUgYWxsIHRvb2xzLCBcImRlZmF1bHRcIiB0byB1c2UgYWxsIHRvb2xzLCBvciBzcGVjaWZ5IHRvb2wgbmFtZXMgKGUuZy4gXCJCYXNoLEVkaXQsUmVhZFwiKS4nLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tZGlzYWxsb3dlZFRvb2xzLCAtLWRpc2FsbG93ZWQtdG9vbHMgPHRvb2xzLi4uPicsXG4gICAgICAnQ29tbWEgb3Igc3BhY2Utc2VwYXJhdGVkIGxpc3Qgb2YgdG9vbCBuYW1lcyB0byBkZW55IChlLmcuIFwiQmFzaChnaXQ6KikgRWRpdFwiKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1tY3AtY29uZmlnIDxjb25maWdzLi4uPicsXG4gICAgICAnTG9hZCBNQ1Agc2VydmVycyBmcm9tIEpTT04gZmlsZXMgb3Igc3RyaW5ncyAoc3BhY2Utc2VwYXJhdGVkKScsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1wZXJtaXNzaW9uLXByb21wdC10b29sIDx0b29sPicsXG4gICAgICAgICdNQ1AgdG9vbCB0byB1c2UgZm9yIHBlcm1pc3Npb24gcHJvbXB0cyAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpJyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcihTdHJpbmcpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tc3lzdGVtLXByb21wdCA8cHJvbXB0PicsXG4gICAgICAgICdTeXN0ZW0gcHJvbXB0IHRvIHVzZSBmb3IgdGhlIHNlc3Npb24nLFxuICAgICAgKS5hcmdQYXJzZXIoU3RyaW5nKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXN5c3RlbS1wcm9tcHQtZmlsZSA8ZmlsZT4nLFxuICAgICAgICAnUmVhZCBzeXN0ZW0gcHJvbXB0IGZyb20gYSBmaWxlJyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcihTdHJpbmcpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tYXBwZW5kLXN5c3RlbS1wcm9tcHQgPHByb21wdD4nLFxuICAgICAgICAnQXBwZW5kIGEgc3lzdGVtIHByb21wdCB0byB0aGUgZGVmYXVsdCBzeXN0ZW0gcHJvbXB0JyxcbiAgICAgICkuYXJnUGFyc2VyKFN0cmluZyksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1hcHBlbmQtc3lzdGVtLXByb21wdC1maWxlIDxmaWxlPicsXG4gICAgICAgICdSZWFkIHN5c3RlbSBwcm9tcHQgZnJvbSBhIGZpbGUgYW5kIGFwcGVuZCB0byB0aGUgZGVmYXVsdCBzeXN0ZW0gcHJvbXB0JyxcbiAgICAgIClcbiAgICAgICAgLmFyZ1BhcnNlcihTdHJpbmcpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tcGVybWlzc2lvbi1tb2RlIDxtb2RlPicsXG4gICAgICAgICdQZXJtaXNzaW9uIG1vZGUgdG8gdXNlIGZvciB0aGUgc2Vzc2lvbicsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuY2hvaWNlcyhQRVJNSVNTSU9OX01PREVTKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctYywgLS1jb250aW51ZScsXG4gICAgICAnQ29udGludWUgdGhlIG1vc3QgcmVjZW50IGNvbnZlcnNhdGlvbiBpbiB0aGUgY3VycmVudCBkaXJlY3RvcnknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctciwgLS1yZXN1bWUgW3ZhbHVlXScsXG4gICAgICAnUmVzdW1lIGEgY29udmVyc2F0aW9uIGJ5IHNlc3Npb24gSUQsIG9yIG9wZW4gaW50ZXJhY3RpdmUgcGlja2VyIHdpdGggb3B0aW9uYWwgc2VhcmNoIHRlcm0nLFxuICAgICAgdmFsdWUgPT4gdmFsdWUgfHwgdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWZvcmstc2Vzc2lvbicsXG4gICAgICAnV2hlbiByZXN1bWluZywgY3JlYXRlIGEgbmV3IHNlc3Npb24gSUQgaW5zdGVhZCBvZiByZXVzaW5nIHRoZSBvcmlnaW5hbCAodXNlIHdpdGggLS1yZXN1bWUgb3IgLS1jb250aW51ZSknLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXByZWZpbGwgPHRleHQ+JyxcbiAgICAgICAgJ1ByZS1maWxsIHRoZSBwcm9tcHQgaW5wdXQgd2l0aCB0ZXh0IHdpdGhvdXQgc3VibWl0dGluZyBpdCcsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1kZWVwLWxpbmstb3JpZ2luJyxcbiAgICAgICAgJ1NpZ25hbCB0aGF0IHRoaXMgc2Vzc2lvbiB3YXMgbGF1bmNoZWQgZnJvbSBhIGRlZXAgbGluaycsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIC5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1kZWVwLWxpbmstcmVwbyA8c2x1Zz4nLFxuICAgICAgICAnUmVwbyBzbHVnIHRoZSBkZWVwIGxpbmsgP3JlcG89IHBhcmFtZXRlciByZXNvbHZlZCB0byB0aGUgY3VycmVudCBjd2QnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tZGVlcC1saW5rLWxhc3QtZmV0Y2ggPG1zPicsXG4gICAgICAgICdGRVRDSF9IRUFEIG10aW1lIGluIGVwb2NoIG1zLCBwcmVjb21wdXRlZCBieSB0aGUgZGVlcCBsaW5rIHRyYW1wb2xpbmUnLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKHYgPT4ge1xuICAgICAgICAgIGNvbnN0IG4gPSBOdW1iZXIodilcbiAgICAgICAgICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKG4pID8gbiA6IHVuZGVmaW5lZFxuICAgICAgICB9KVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWZyb20tcHIgW3ZhbHVlXScsXG4gICAgICAnUmVzdW1lIGEgc2Vzc2lvbiBsaW5rZWQgdG8gYSBQUiBieSBQUiBudW1iZXIvVVJMLCBvciBvcGVuIGludGVyYWN0aXZlIHBpY2tlciB3aXRoIG9wdGlvbmFsIHNlYXJjaCB0ZXJtJyxcbiAgICAgIHZhbHVlID0+IHZhbHVlIHx8IHRydWUsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1uby1zZXNzaW9uLXBlcnNpc3RlbmNlJyxcbiAgICAgICdEaXNhYmxlIHNlc3Npb24gcGVyc2lzdGVuY2UgLSBzZXNzaW9ucyB3aWxsIG5vdCBiZSBzYXZlZCB0byBkaXNrIGFuZCBjYW5ub3QgYmUgcmVzdW1lZCAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpJyxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXJlc3VtZS1zZXNzaW9uLWF0IDxtZXNzYWdlIGlkPicsXG4gICAgICAgICdXaGVuIHJlc3VtaW5nLCBvbmx5IG1lc3NhZ2VzIHVwIHRvIGFuZCBpbmNsdWRpbmcgdGhlIGFzc2lzdGFudCBtZXNzYWdlIHdpdGggPG1lc3NhZ2UuaWQ+ICh1c2Ugd2l0aCAtLXJlc3VtZSBpbiBwcmludCBtb2RlKScsXG4gICAgICApXG4gICAgICAgIC5hcmdQYXJzZXIoU3RyaW5nKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXJld2luZC1maWxlcyA8dXNlci1tZXNzYWdlLWlkPicsXG4gICAgICAgICdSZXN0b3JlIGZpbGVzIHRvIHN0YXRlIGF0IHRoZSBzcGVjaWZpZWQgdXNlciBtZXNzYWdlIGFuZCBleGl0IChyZXF1aXJlcyAtLXJlc3VtZSknLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgICAvLyBAW01PREVMIExBVU5DSF06IFVwZGF0ZSB0aGUgZXhhbXBsZSBtb2RlbCBJRCBpbiB0aGUgLS1tb2RlbCBoZWxwIHRleHQuXG4gICAgLm9wdGlvbihcbiAgICAgICctLW1vZGVsIDxtb2RlbD4nLFxuICAgICAgYE1vZGVsIGZvciB0aGUgY3VycmVudCBzZXNzaW9uLiBQcm92aWRlIGFuIGFsaWFzIGZvciB0aGUgbGF0ZXN0IG1vZGVsIChlLmcuICdzb25uZXQnIG9yICdvcHVzJykgb3IgYSBtb2RlbCdzIGZ1bGwgbmFtZSAoZS5nLiAnY2xhdWRlLW9wdXMtNC03JykuYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWVmZm9ydCA8bGV2ZWw+JyxcbiAgICAgICAgYEVmZm9ydCBsZXZlbCBmb3IgdGhlIGN1cnJlbnQgc2Vzc2lvbiAobG93LCBtZWRpdW0sIGhpZ2gsIHhoaWdoLCBtYXgpYCxcbiAgICAgICkuYXJnUGFyc2VyKChyYXdWYWx1ZTogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHZhbHVlID0gcmF3VmFsdWUudG9Mb3dlckNhc2UoKVxuICAgICAgICBjb25zdCBhbGxvd2VkID0gWydsb3cnLCAnbWVkaXVtJywgJ2hpZ2gnLCAneGhpZ2gnLCAnbWF4J11cbiAgICAgICAgaWYgKCFhbGxvd2VkLmluY2x1ZGVzKHZhbHVlKSkge1xuICAgICAgICAgIHRocm93IG5ldyBJbnZhbGlkQXJndW1lbnRFcnJvcihcbiAgICAgICAgICAgIGBJdCBtdXN0IGJlIG9uZSBvZjogJHthbGxvd2VkLmpvaW4oJywgJyl9YCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHZhbHVlXG4gICAgICB9KSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWFnZW50IDxhZ2VudD4nLFxuICAgICAgYEFnZW50IGZvciB0aGUgY3VycmVudCBzZXNzaW9uLiBPdmVycmlkZXMgdGhlICdhZ2VudCcgc2V0dGluZy5gLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYmV0YXMgPGJldGFzLi4uPicsXG4gICAgICAnQmV0YSBoZWFkZXJzIHRvIGluY2x1ZGUgaW4gQVBJIHJlcXVlc3RzIChBUEkga2V5IHVzZXJzIG9ubHkpJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWZhbGxiYWNrLW1vZGVsIDxtb2RlbD4nLFxuICAgICAgJ0VuYWJsZSBhdXRvbWF0aWMgZmFsbGJhY2sgdG8gc3BlY2lmaWVkIG1vZGVsIHdoZW4gZGVmYXVsdCBtb2RlbCBpcyBvdmVybG9hZGVkIChvbmx5IHdvcmtzIHdpdGggLS1wcmludCknLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0td29ya2xvYWQgPHRhZz4nLFxuICAgICAgICAnV29ya2xvYWQgdGFnIGZvciBiaWxsaW5nLWhlYWRlciBhdHRyaWJ1dGlvbiAoY2Nfd29ya2xvYWQpLiBQcm9jZXNzLXNjb3BlZDsgc2V0IGJ5IFNESyBkYWVtb24gY2FsbGVycyB0aGF0IHNwYXduIHN1YnByb2Nlc3NlcyBmb3IgY3JvbiB3b3JrLiAob25seSB3b3JrcyB3aXRoIC0tcHJpbnQpJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLXNldHRpbmdzIDxmaWxlLW9yLWpzb24+JyxcbiAgICAgICdQYXRoIHRvIGEgc2V0dGluZ3MgSlNPTiBmaWxlIG9yIGEgSlNPTiBzdHJpbmcgdG8gbG9hZCBhZGRpdGlvbmFsIHNldHRpbmdzIGZyb20nLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYWRkLWRpciA8ZGlyZWN0b3JpZXMuLi4+JyxcbiAgICAgICdBZGRpdGlvbmFsIGRpcmVjdG9yaWVzIHRvIGFsbG93IHRvb2wgYWNjZXNzIHRvJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWlkZScsXG4gICAgICAnQXV0b21hdGljYWxseSBjb25uZWN0IHRvIElERSBvbiBzdGFydHVwIGlmIGV4YWN0bHkgb25lIHZhbGlkIElERSBpcyBhdmFpbGFibGUnLFxuICAgICAgKCkgPT4gdHJ1ZSxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLXN0cmljdC1tY3AtY29uZmlnJyxcbiAgICAgICdPbmx5IHVzZSBNQ1Agc2VydmVycyBmcm9tIC0tbWNwLWNvbmZpZywgaWdub3JpbmcgYWxsIG90aGVyIE1DUCBjb25maWd1cmF0aW9ucycsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tc2Vzc2lvbi1pZCA8dXVpZD4nLFxuICAgICAgJ1VzZSBhIHNwZWNpZmljIHNlc3Npb24gSUQgZm9yIHRoZSBjb252ZXJzYXRpb24gKG11c3QgYmUgYSB2YWxpZCBVVUlEKScsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLW4sIC0tbmFtZSA8bmFtZT4nLFxuICAgICAgJ1NldCBhIGRpc3BsYXkgbmFtZSBmb3IgdGhpcyBzZXNzaW9uIChzaG93biBpbiAvcmVzdW1lIGFuZCB0ZXJtaW5hbCB0aXRsZSknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYWdlbnRzIDxqc29uPicsXG4gICAgICAnSlNPTiBvYmplY3QgZGVmaW5pbmcgY3VzdG9tIGFnZW50cyAoZS5nLiBcXCd7XCJyZXZpZXdlclwiOiB7XCJkZXNjcmlwdGlvblwiOiBcIlJldmlld3MgY29kZVwiLCBcInByb21wdFwiOiBcIllvdSBhcmUgYSBjb2RlIHJldmlld2VyXCJ9fVxcJyknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy0tc2V0dGluZy1zb3VyY2VzIDxzb3VyY2VzPicsXG4gICAgICAnQ29tbWEtc2VwYXJhdGVkIGxpc3Qgb2Ygc2V0dGluZyBzb3VyY2VzIHRvIGxvYWQgKHVzZXIsIHByb2plY3QsIGxvY2FsKS4nLFxuICAgIClcbiAgICAvLyBnaC0zMzUwODogPHBhdGhzLi4uPiAodmFyaWFkaWMpIGNvbnN1bWVkIGV2ZXJ5dGhpbmcgdW50aWwgdGhlIG5leHRcbiAgICAvLyAtLWZsYWcuIGBjbGF1ZGUgLS1wbHVnaW4tZGlyIC9wYXRoIG1jcCBhZGQgLS10cmFuc3BvcnQgaHR0cGAgc3dhbGxvd2VkXG4gICAgLy8gYG1jcGAgYW5kIGBhZGRgIGFzIHBhdGhzLCB0aGVuIGNob2tlZCBvbiAtLXRyYW5zcG9ydCBhcyBhbiB1bmtub3duXG4gICAgLy8gdG9wLWxldmVsIG9wdGlvbi4gU2luZ2xlLXZhbHVlICsgY29sbGVjdCBhY2N1bXVsYXRvciBtZWFucyBlYWNoXG4gICAgLy8gLS1wbHVnaW4tZGlyIHRha2VzIGV4YWN0bHkgb25lIGFyZzsgcmVwZWF0IHRoZSBmbGFnIGZvciBtdWx0aXBsZSBkaXJzLlxuICAgIC5vcHRpb24oXG4gICAgICAnLS1wbHVnaW4tZGlyIDxwYXRoPicsXG4gICAgICAnTG9hZCBwbHVnaW5zIGZyb20gYSBkaXJlY3RvcnkgZm9yIHRoaXMgc2Vzc2lvbiBvbmx5IChyZXBlYXRhYmxlOiAtLXBsdWdpbi1kaXIgQSAtLXBsdWdpbi1kaXIgQiknLFxuICAgICAgKHZhbDogc3RyaW5nLCBwcmV2OiBzdHJpbmdbXSkgPT4gWy4uLnByZXYsIHZhbF0sXG4gICAgICBbXSBhcyBzdHJpbmdbXSxcbiAgICApXG4gICAgLm9wdGlvbignLS1kaXNhYmxlLXNsYXNoLWNvbW1hbmRzJywgJ0Rpc2FibGUgYWxsIHNraWxscycsICgpID0+IHRydWUpXG4gICAgLm9wdGlvbignLS1jaHJvbWUnLCAnRW5hYmxlIENsYXVkZSBpbiBDaHJvbWUgaW50ZWdyYXRpb24nKVxuICAgIC5vcHRpb24oJy0tbm8tY2hyb21lJywgJ0Rpc2FibGUgQ2xhdWRlIGluIENocm9tZSBpbnRlZ3JhdGlvbicpXG4gICAgLm9wdGlvbihcbiAgICAgICctLWZpbGUgPHNwZWNzLi4uPicsXG4gICAgICAnRmlsZSByZXNvdXJjZXMgdG8gZG93bmxvYWQgYXQgc3RhcnR1cC4gRm9ybWF0OiBmaWxlX2lkOnJlbGF0aXZlX3BhdGggKGUuZy4sIC0tZmlsZSBmaWxlX2FiYzpkb2MudHh0IGZpbGVfZGVmOmltZy5wbmcpJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAocHJvbXB0LCBvcHRpb25zKSA9PiB7XG4gICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2hhbmRsZXJfc3RhcnQnKVxuXG4gICAgICAvLyAtLWJhcmUgPSBvbmUtc3dpdGNoIG1pbmltYWwgbW9kZS4gU2V0cyBTSU1QTEUgc28gYWxsIHRoZSBleGlzdGluZ1xuICAgICAgLy8gZ2F0ZXMgZmlyZSAoQ0xBVURFLm1kLCBza2lsbHMsIGhvb2tzIGluc2lkZSBleGVjdXRlSG9va3MsIGFnZW50XG4gICAgICAvLyBkaXItd2FsaykuIE11c3QgYmUgc2V0IGJlZm9yZSBzZXR1cCgpIC8gYW55IG9mIHRoZSBnYXRlZCB3b3JrIHJ1bnMuXG4gICAgICBpZiAoKG9wdGlvbnMgYXMgeyBiYXJlPzogYm9vbGVhbiB9KS5iYXJlKSB7XG4gICAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1NJTVBMRSA9ICcxJ1xuICAgICAgfVxuXG4gICAgICAvLyBJZ25vcmUgXCJjb2RlXCIgYXMgYSBwcm9tcHQgLSB0cmVhdCBpdCB0aGUgc2FtZSBhcyBubyBwcm9tcHRcbiAgICAgIGlmIChwcm9tcHQgPT09ICdjb2RlJykge1xuICAgICAgICBsb2dFdmVudCgndGVuZ3VfY29kZV9wcm9tcHRfaWdub3JlZCcsIHt9KVxuICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICBjaGFsay55ZWxsb3coJ1RpcDogWW91IGNhbiBsYXVuY2ggQ2xhdWRlIENvZGUgd2l0aCBqdXN0IGBjbGF1ZGVgJyksXG4gICAgICAgIClcbiAgICAgICAgcHJvbXB0ID0gdW5kZWZpbmVkXG4gICAgICB9XG5cbiAgICAgIC8vIExvZyBldmVudCBmb3IgYW55IHNpbmdsZS13b3JkIHByb21wdFxuICAgICAgaWYgKFxuICAgICAgICBwcm9tcHQgJiZcbiAgICAgICAgdHlwZW9mIHByb21wdCA9PT0gJ3N0cmluZycgJiZcbiAgICAgICAgIS9cXHMvLnRlc3QocHJvbXB0KSAmJlxuICAgICAgICBwcm9tcHQubGVuZ3RoID4gMFxuICAgICAgKSB7XG4gICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zaW5nbGVfd29yZF9wcm9tcHQnLCB7IGxlbmd0aDogcHJvbXB0Lmxlbmd0aCB9KVxuICAgICAgfVxuXG4gICAgICAvLyBBc3Npc3RhbnQgbW9kZTogd2hlbiAuY2xhdWRlL3NldHRpbmdzLmpzb24gaGFzIGFzc2lzdGFudDogdHJ1ZSBBTkRcbiAgICAgIC8vIHRoZSB0ZW5ndV9rYWlyb3MgR3Jvd3RoQm9vayBnYXRlIGlzIG9uLCBmb3JjZSBicmllZiBvbi4gUGVybWlzc2lvblxuICAgICAgLy8gbW9kZSBpcyBsZWZ0IHRvIHRoZSB1c2VyIFx1MjAxNCBzZXR0aW5ncyBkZWZhdWx0TW9kZSBvciAtLXBlcm1pc3Npb24tbW9kZVxuICAgICAgLy8gYXBwbHkgYXMgbm9ybWFsLiBSRVBMLXR5cGVkIG1lc3NhZ2VzIGFscmVhZHkgZGVmYXVsdCB0byAnbmV4dCdcbiAgICAgIC8vIHByaW9yaXR5IChtZXNzYWdlUXVldWVNYW5hZ2VyLmVucXVldWUpIHNvIHRoZXkgZHJhaW4gbWlkLXR1cm4gYmV0d2VlblxuICAgICAgLy8gdG9vbCBjYWxscy4gU2VuZFVzZXJNZXNzYWdlIChCcmllZlRvb2wpIGlzIGVuYWJsZWQgdmlhIHRoZSBicmllZiBlbnZcbiAgICAgIC8vIHZhci4gU2xlZXBUb29sIHN0YXlzIGRpc2FibGVkIChpdHMgaXNFbmFibGVkKCkgZ2F0ZXMgb24gcHJvYWN0aXZlKS5cbiAgICAgIC8vIGthaXJvc0VuYWJsZWQgaXMgY29tcHV0ZWQgb25jZSBoZXJlIGFuZCByZXVzZWQgYXQgdGhlXG4gICAgICAvLyBnZXRBc3Npc3RhbnRTeXN0ZW1Qcm9tcHRBZGRlbmR1bSgpIGNhbGwgc2l0ZSBmdXJ0aGVyIGRvd24uXG4gICAgICAvL1xuICAgICAgLy8gVHJ1c3QgZ2F0ZTogLmNsYXVkZS9zZXR0aW5ncy5qc29uIGlzIGF0dGFja2VyLWNvbnRyb2xsYWJsZSBpbiBhblxuICAgICAgLy8gdW50cnVzdGVkIGNsb25lLiBXZSBydW4gfjEwMDAgbGluZXMgYmVmb3JlIHNob3dTZXR1cFNjcmVlbnMoKSBzaG93c1xuICAgICAgLy8gdGhlIHRydXN0IGRpYWxvZywgYW5kIGJ5IHRoZW4gd2UndmUgYWxyZWFkeSBhcHBlbmRlZFxuICAgICAgLy8gLmNsYXVkZS9hZ2VudHMvYXNzaXN0YW50Lm1kIHRvIHRoZSBzeXN0ZW0gcHJvbXB0LiBSZWZ1c2UgdG8gYWN0aXZhdGVcbiAgICAgIC8vIHVudGlsIHRoZSBkaXJlY3RvcnkgaGFzIGJlZW4gZXhwbGljaXRseSB0cnVzdGVkLlxuICAgICAgbGV0IGthaXJvc0VuYWJsZWQgPSBmYWxzZVxuICAgICAgbGV0IGFzc2lzdGFudFRlYW1Db250ZXh0OlxuICAgICAgICB8IEF3YWl0ZWQ8XG4gICAgICAgICAgICBSZXR1cm5UeXBlPFxuICAgICAgICAgICAgICBOb25OdWxsYWJsZTx0eXBlb2YgYXNzaXN0YW50TW9kdWxlPlsnaW5pdGlhbGl6ZUFzc2lzdGFudFRlYW0nXVxuICAgICAgICAgICAgPlxuICAgICAgICAgID5cbiAgICAgICAgfCB1bmRlZmluZWRcbiAgICAgIGlmIChcbiAgICAgICAgZmVhdHVyZSgnS0FJUk9TJykgJiZcbiAgICAgICAgKG9wdGlvbnMgYXMgeyBhc3Npc3RhbnQ/OiBib29sZWFuIH0pLmFzc2lzdGFudCAmJlxuICAgICAgICBhc3Npc3RhbnRNb2R1bGVcbiAgICAgICkge1xuICAgICAgICAvLyAtLWFzc2lzdGFudCAoQWdlbnQgU0RLIGRhZW1vbiBtb2RlKTogZm9yY2UgdGhlIGxhdGNoIGJlZm9yZVxuICAgICAgICAvLyBpc0Fzc2lzdGFudE1vZGUoKSBydW5zIGJlbG93LiBUaGUgZGFlbW9uIGhhcyBhbHJlYWR5IGNoZWNrZWRcbiAgICAgICAgLy8gZW50aXRsZW1lbnQgXHUyMDE0IGRvbid0IG1ha2UgdGhlIGNoaWxkIHJlLWNoZWNrIHRlbmd1X2thaXJvcy5cbiAgICAgICAgYXNzaXN0YW50TW9kdWxlLm1hcmtBc3Npc3RhbnRGb3JjZWQoKVxuICAgICAgfVxuICAgICAgaWYgKFxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSAmJlxuICAgICAgICBhc3Npc3RhbnRNb2R1bGU/LmlzQXNzaXN0YW50TW9kZSgpICYmXG4gICAgICAgIC8vIFNwYXduZWQgdGVhbW1hdGVzIHNoYXJlIHRoZSBsZWFkZXIncyBjd2QgKyBzZXR0aW5ncy5qc29uLCBzb1xuICAgICAgICAvLyBpc0Fzc2lzdGFudE1vZGUoKSBpcyB0cnVlIGZvciB0aGVtIHRvby4gLS1hZ2VudC1pZCBiZWluZyBzZXRcbiAgICAgICAgLy8gbWVhbnMgd2UgQVJFIGEgc3Bhd25lZCB0ZWFtbWF0ZSAoZXh0cmFjdFRlYW1tYXRlT3B0aW9ucyBydW5zXG4gICAgICAgIC8vIH4xNzAgbGluZXMgbGF0ZXIgc28gY2hlY2sgdGhlIHJhdyBjb21tYW5kZXIgb3B0aW9uKSBcdTIwMTQgZG9uJ3RcbiAgICAgICAgLy8gcmUtaW5pdCB0aGUgdGVhbSBvciBvdmVycmlkZSB0ZWFtbWF0ZU1vZGUvcHJvYWN0aXZlL2JyaWVmLlxuICAgICAgICAhKG9wdGlvbnMgYXMgeyBhZ2VudElkPzogdW5rbm93biB9KS5hZ2VudElkICYmXG4gICAgICAgIGthaXJvc0dhdGVcbiAgICAgICkge1xuICAgICAgICBpZiAoIWNoZWNrSGFzVHJ1c3REaWFsb2dBY2NlcHRlZCgpKSB7XG4gICAgICAgICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3VzcGljaW91cy9ub0NvbnNvbGU6OiBpbnRlbnRpb25hbCBjb25zb2xlIG91dHB1dFxuICAgICAgICAgIGNvbnNvbGUud2FybihcbiAgICAgICAgICAgIGNoYWxrLnllbGxvdyhcbiAgICAgICAgICAgICAgJ0Fzc2lzdGFudCBtb2RlIGRpc2FibGVkOiBkaXJlY3RvcnkgaXMgbm90IHRydXN0ZWQuIEFjY2VwdCB0aGUgdHJ1c3QgZGlhbG9nIGFuZCByZXN0YXJ0LicsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBCbG9ja2luZyBnYXRlIGNoZWNrIFx1MjAxNCByZXR1cm5zIGNhY2hlZCBgdHJ1ZWAgaW5zdGFudGx5OyBpZiBkaXNrXG4gICAgICAgICAgLy8gY2FjaGUgaXMgZmFsc2UvbWlzc2luZywgbGF6aWx5IGluaXRzIEdyb3d0aEJvb2sgYW5kIGZldGNoZXMgZnJlc2hcbiAgICAgICAgICAvLyAobWF4IH41cykuIC0tYXNzaXN0YW50IHNraXBzIHRoZSBnYXRlIGVudGlyZWx5IChkYWVtb24gaXNcbiAgICAgICAgICAvLyBwcmUtZW50aXRsZWQpLlxuICAgICAgICAgIGthaXJvc0VuYWJsZWQgPVxuICAgICAgICAgICAgYXNzaXN0YW50TW9kdWxlLmlzQXNzaXN0YW50Rm9yY2VkKCkgfHxcbiAgICAgICAgICAgIChhd2FpdCBrYWlyb3NHYXRlLmlzS2Fpcm9zRW5hYmxlZCgpKVxuICAgICAgICAgIGlmIChrYWlyb3NFbmFibGVkKSB7XG4gICAgICAgICAgICBjb25zdCBvcHRzID0gb3B0aW9ucyBhcyB7IGJyaWVmPzogYm9vbGVhbiB9XG4gICAgICAgICAgICBvcHRzLmJyaWVmID0gdHJ1ZVxuICAgICAgICAgICAgc2V0S2Fpcm9zQWN0aXZlKHRydWUpXG4gICAgICAgICAgICAvLyBQcmUtc2VlZCBhbiBpbi1wcm9jZXNzIHRlYW0gc28gQWdlbnQobmFtZTogXCJmb29cIikgc3Bhd25zXG4gICAgICAgICAgICAvLyB0ZWFtbWF0ZXMgd2l0aG91dCBUZWFtQ3JlYXRlLiBNdXN0IHJ1biBCRUZPUkUgc2V0dXAoKSBjYXB0dXJlc1xuICAgICAgICAgICAgLy8gdGhlIHRlYW1tYXRlTW9kZSBzbmFwc2hvdCAoaW5pdGlhbGl6ZUFzc2lzdGFudFRlYW0gY2FsbHNcbiAgICAgICAgICAgIC8vIHNldENsaVRlYW1tYXRlTW9kZU92ZXJyaWRlIGludGVybmFsbHkpLlxuICAgICAgICAgICAgYXNzaXN0YW50VGVhbUNvbnRleHQgPVxuICAgICAgICAgICAgICBhd2FpdCBhc3Npc3RhbnRNb2R1bGUuaW5pdGlhbGl6ZUFzc2lzdGFudFRlYW0oKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBjb25zdCB7XG4gICAgICAgIGRlYnVnID0gZmFsc2UsXG4gICAgICAgIGRlYnVnVG9TdGRlcnIgPSBmYWxzZSxcbiAgICAgICAgZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMgPSBmYWxzZSxcbiAgICAgICAgdG9vbHM6IGJhc2VUb29scyA9IFtdLFxuICAgICAgICBhbGxvd2VkVG9vbHMgPSBbXSxcbiAgICAgICAgZGlzYWxsb3dlZFRvb2xzID0gW10sXG4gICAgICAgIG1jcENvbmZpZyA9IFtdLFxuICAgICAgICBwZXJtaXNzaW9uTW9kZTogcGVybWlzc2lvbk1vZGVDbGksXG4gICAgICAgIGFkZERpciA9IFtdLFxuICAgICAgICBmYWxsYmFja01vZGVsLFxuICAgICAgICBiZXRhcyA9IFtdLFxuICAgICAgICBpZGUgPSBmYWxzZSxcbiAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICBpbmNsdWRlSG9va0V2ZW50cyxcbiAgICAgICAgaW5jbHVkZVBhcnRpYWxNZXNzYWdlcyxcbiAgICAgIH0gPSBvcHRpb25zXG5cbiAgICAgIGlmIChvcHRpb25zLnByZWZpbGwpIHtcbiAgICAgICAgc2VlZEVhcmx5SW5wdXQob3B0aW9ucy5wcmVmaWxsKVxuICAgICAgfVxuXG4gICAgICAvLyBQcm9taXNlIGZvciBmaWxlIGRvd25sb2FkcyAtIHN0YXJ0ZWQgZWFybHksIGF3YWl0ZWQgYmVmb3JlIFJFUEwgcmVuZGVyc1xuICAgICAgbGV0IGZpbGVEb3dubG9hZFByb21pc2U6IFByb21pc2U8RG93bmxvYWRSZXN1bHRbXT4gfCB1bmRlZmluZWRcblxuICAgICAgY29uc3QgYWdlbnRzSnNvbiA9IG9wdGlvbnMuYWdlbnRzXG4gICAgICBjb25zdCBhZ2VudENsaSA9IG9wdGlvbnMuYWdlbnRcbiAgICAgIGlmIChmZWF0dXJlKCdCR19TRVNTSU9OUycpICYmIGFnZW50Q2xpKSB7XG4gICAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0FHRU5UID0gYWdlbnRDbGlcbiAgICAgIH1cblxuICAgICAgLy8gTk9URTogTFNQIG1hbmFnZXIgaW5pdGlhbGl6YXRpb24gaXMgaW50ZW50aW9uYWxseSBkZWZlcnJlZCB1bnRpbCBhZnRlclxuICAgICAgLy8gdGhlIHRydXN0IGRpYWxvZyBpcyBhY2NlcHRlZC4gVGhpcyBwcmV2ZW50cyBwbHVnaW4gTFNQIHNlcnZlcnMgZnJvbVxuICAgICAgLy8gZXhlY3V0aW5nIGNvZGUgaW4gdW50cnVzdGVkIGRpcmVjdG9yaWVzIGJlZm9yZSB1c2VyIGNvbnNlbnQuXG5cbiAgICAgIC8vIEV4dHJhY3QgdGhlc2Ugc2VwYXJhdGVseSBzbyB0aGV5IGNhbiBiZSBtb2RpZmllZCBpZiBuZWVkZWRcbiAgICAgIGxldCBvdXRwdXRGb3JtYXQgPSBvcHRpb25zLm91dHB1dEZvcm1hdFxuICAgICAgbGV0IGlucHV0Rm9ybWF0ID0gb3B0aW9ucy5pbnB1dEZvcm1hdFxuICAgICAgbGV0IHZlcmJvc2UgPSBvcHRpb25zLnZlcmJvc2UgPz8gZ2V0R2xvYmFsQ29uZmlnKCkudmVyYm9zZVxuICAgICAgbGV0IHByaW50ID0gb3B0aW9ucy5wcmludFxuICAgICAgY29uc3QgaW5pdCA9IG9wdGlvbnMuaW5pdCA/PyBmYWxzZVxuICAgICAgY29uc3QgaW5pdE9ubHkgPSBvcHRpb25zLmluaXRPbmx5ID8/IGZhbHNlXG4gICAgICBjb25zdCBtYWludGVuYW5jZSA9IG9wdGlvbnMubWFpbnRlbmFuY2UgPz8gZmFsc2VcblxuICAgICAgLy8gRXh0cmFjdCBkaXNhYmxlIHNsYXNoIGNvbW1hbmRzIGZsYWdcbiAgICAgIGNvbnN0IGRpc2FibGVTbGFzaENvbW1hbmRzID0gb3B0aW9ucy5kaXNhYmxlU2xhc2hDb21tYW5kcyB8fCBmYWxzZVxuXG4gICAgICAvLyBFeHRyYWN0IHRhc2tzIG1vZGUgb3B0aW9ucyAoYW50LW9ubHkpXG4gICAgICBjb25zdCB0YXNrc09wdGlvbiA9XG4gICAgICAgIFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcgJiZcbiAgICAgICAgKG9wdGlvbnMgYXMgeyB0YXNrcz86IGJvb2xlYW4gfCBzdHJpbmcgfSkudGFza3NcbiAgICAgIGNvbnN0IHRhc2tMaXN0SWQgPSB0YXNrc09wdGlvblxuICAgICAgICA/IHR5cGVvZiB0YXNrc09wdGlvbiA9PT0gJ3N0cmluZydcbiAgICAgICAgICA/IHRhc2tzT3B0aW9uXG4gICAgICAgICAgOiBERUZBVUxUX1RBU0tTX01PREVfVEFTS19MSVNUX0lEXG4gICAgICAgIDogdW5kZWZpbmVkXG4gICAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50JyAmJiB0YXNrTGlzdElkKSB7XG4gICAgICAgIHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX1RBU0tfTElTVF9JRCA9IHRhc2tMaXN0SWRcbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCB3b3JrdHJlZSBvcHRpb25cbiAgICAgIC8vIHdvcmt0cmVlIGNhbiBiZSB0cnVlIChmbGFnIHdpdGhvdXQgdmFsdWUpIG9yIGEgc3RyaW5nIChjdXN0b20gbmFtZSBvciBQUiByZWZlcmVuY2UpXG4gICAgICBjb25zdCB3b3JrdHJlZU9wdGlvbiA9IGlzV29ya3RyZWVNb2RlRW5hYmxlZCgpXG4gICAgICAgID8gKG9wdGlvbnMgYXMgeyB3b3JrdHJlZT86IGJvb2xlYW4gfCBzdHJpbmcgfSkud29ya3RyZWVcbiAgICAgICAgOiB1bmRlZmluZWRcbiAgICAgIGxldCB3b3JrdHJlZU5hbWUgPVxuICAgICAgICB0eXBlb2Ygd29ya3RyZWVPcHRpb24gPT09ICdzdHJpbmcnID8gd29ya3RyZWVPcHRpb24gOiB1bmRlZmluZWRcbiAgICAgIGNvbnN0IHdvcmt0cmVlRW5hYmxlZCA9IHdvcmt0cmVlT3B0aW9uICE9PSB1bmRlZmluZWRcblxuICAgICAgLy8gQ2hlY2sgaWYgd29ya3RyZWUgbmFtZSBpcyBhIFBSIHJlZmVyZW5jZSAoI04gb3IgR2l0SHViIFBSIFVSTClcbiAgICAgIGxldCB3b3JrdHJlZVBSTnVtYmVyOiBudW1iZXIgfCB1bmRlZmluZWRcbiAgICAgIGlmICh3b3JrdHJlZU5hbWUpIHtcbiAgICAgICAgY29uc3QgcHJOdW0gPSBwYXJzZVBSUmVmZXJlbmNlKHdvcmt0cmVlTmFtZSlcbiAgICAgICAgaWYgKHByTnVtICE9PSBudWxsKSB7XG4gICAgICAgICAgd29ya3RyZWVQUk51bWJlciA9IHByTnVtXG4gICAgICAgICAgd29ya3RyZWVOYW1lID0gdW5kZWZpbmVkIC8vIHNsdWcgd2lsbCBiZSBnZW5lcmF0ZWQgaW4gc2V0dXAoKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgdG11eCBvcHRpb24gKHJlcXVpcmVzIC0td29ya3RyZWUpXG4gICAgICBjb25zdCB0bXV4RW5hYmxlZCA9XG4gICAgICAgIGlzV29ya3RyZWVNb2RlRW5hYmxlZCgpICYmIChvcHRpb25zIGFzIHsgdG11eD86IGJvb2xlYW4gfSkudG11eCA9PT0gdHJ1ZVxuXG4gICAgICAvLyBWYWxpZGF0ZSB0bXV4IG9wdGlvblxuICAgICAgaWYgKHRtdXhFbmFibGVkKSB7XG4gICAgICAgIGlmICghd29ya3RyZWVFbmFibGVkKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoY2hhbGsucmVkKCdFcnJvcjogLS10bXV4IHJlcXVpcmVzIC0td29ya3RyZWVcXG4nKSlcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuICAgICAgICBpZiAoZ2V0UGxhdGZvcm0oKSA9PT0gJ3dpbmRvd3MnKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoJ0Vycm9yOiAtLXRtdXggaXMgbm90IHN1cHBvcnRlZCBvbiBXaW5kb3dzXFxuJyksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICAgIGlmICghKGF3YWl0IGlzVG11eEF2YWlsYWJsZSgpKSkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICBgRXJyb3I6IHRtdXggaXMgbm90IGluc3RhbGxlZC5cXG4ke2dldFRtdXhJbnN0YWxsSW5zdHJ1Y3Rpb25zKCl9XFxuYCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgdGVhbW1hdGUgb3B0aW9ucyAoZm9yIHRtdXgtc3Bhd25lZCBhZ2VudHMpXG4gICAgICAvLyBEZWNsYXJlZCBvdXRzaWRlIHRoZSBpZiBibG9jayBzbyBpdCdzIGFjY2Vzc2libGUgbGF0ZXIgZm9yIHN5c3RlbSBwcm9tcHQgYWRkZW5kdW1cbiAgICAgIGxldCBzdG9yZWRUZWFtbWF0ZU9wdHM6IFRlYW1tYXRlT3B0aW9ucyB8IHVuZGVmaW5lZFxuICAgICAgaWYgKGlzQWdlbnRTd2FybXNFbmFibGVkKCkpIHtcbiAgICAgICAgLy8gRXh0cmFjdCBhZ2VudCBpZGVudGl0eSBvcHRpb25zIChmb3IgdG11eC1zcGF3bmVkIGFnZW50cylcbiAgICAgICAgLy8gVGhlc2UgcmVwbGFjZSB0aGUgQ0xBVURFX0NPREVfKiBlbnZpcm9ubWVudCB2YXJpYWJsZXNcbiAgICAgICAgY29uc3QgdGVhbW1hdGVPcHRzID0gZXh0cmFjdFRlYW1tYXRlT3B0aW9ucyhvcHRpb25zKVxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHMgPSB0ZWFtbWF0ZU9wdHNcblxuICAgICAgICAvLyBJZiBhbnkgdGVhbW1hdGUgaWRlbnRpdHkgb3B0aW9uIGlzIHByb3ZpZGVkLCBhbGwgdGhyZWUgcmVxdWlyZWQgb25lcyBtdXN0IGJlIHByZXNlbnRcbiAgICAgICAgY29uc3QgaGFzQW55VGVhbW1hdGVPcHQgPVxuICAgICAgICAgIHRlYW1tYXRlT3B0cy5hZ2VudElkIHx8XG4gICAgICAgICAgdGVhbW1hdGVPcHRzLmFnZW50TmFtZSB8fFxuICAgICAgICAgIHRlYW1tYXRlT3B0cy50ZWFtTmFtZVxuICAgICAgICBjb25zdCBoYXNBbGxSZXF1aXJlZFRlYW1tYXRlT3B0cyA9XG4gICAgICAgICAgdGVhbW1hdGVPcHRzLmFnZW50SWQgJiZcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMuYWdlbnROYW1lICYmXG4gICAgICAgICAgdGVhbW1hdGVPcHRzLnRlYW1OYW1lXG5cbiAgICAgICAgaWYgKGhhc0FueVRlYW1tYXRlT3B0ICYmICFoYXNBbGxSZXF1aXJlZFRlYW1tYXRlT3B0cykge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAnRXJyb3I6IC0tYWdlbnQtaWQsIC0tYWdlbnQtbmFtZSwgYW5kIC0tdGVhbS1uYW1lIG11c3QgYWxsIGJlIHByb3ZpZGVkIHRvZ2V0aGVyXFxuJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgdGVhbW1hdGUgaWRlbnRpdHkgaXMgcHJvdmlkZWQgdmlhIENMSSwgc2V0IHVwIGR5bmFtaWNUZWFtQ29udGV4dFxuICAgICAgICBpZiAoXG4gICAgICAgICAgdGVhbW1hdGVPcHRzLmFnZW50SWQgJiZcbiAgICAgICAgICB0ZWFtbWF0ZU9wdHMuYWdlbnROYW1lICYmXG4gICAgICAgICAgdGVhbW1hdGVPcHRzLnRlYW1OYW1lXG4gICAgICAgICkge1xuICAgICAgICAgIGdldFRlYW1tYXRlVXRpbHMoKS5zZXREeW5hbWljVGVhbUNvbnRleHQ/Lih7XG4gICAgICAgICAgICBhZ2VudElkOiB0ZWFtbWF0ZU9wdHMuYWdlbnRJZCxcbiAgICAgICAgICAgIGFnZW50TmFtZTogdGVhbW1hdGVPcHRzLmFnZW50TmFtZSxcbiAgICAgICAgICAgIHRlYW1OYW1lOiB0ZWFtbWF0ZU9wdHMudGVhbU5hbWUsXG4gICAgICAgICAgICBjb2xvcjogdGVhbW1hdGVPcHRzLmFnZW50Q29sb3IsXG4gICAgICAgICAgICBwbGFuTW9kZVJlcXVpcmVkOiB0ZWFtbWF0ZU9wdHMucGxhbk1vZGVSZXF1aXJlZCA/PyBmYWxzZSxcbiAgICAgICAgICAgIHBhcmVudFNlc3Npb25JZDogdGVhbW1hdGVPcHRzLnBhcmVudFNlc3Npb25JZCxcbiAgICAgICAgICB9KVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gU2V0IHRlYW1tYXRlIG1vZGUgQ0xJIG92ZXJyaWRlIGlmIHByb3ZpZGVkXG4gICAgICAgIC8vIFRoaXMgbXVzdCBiZSBkb25lIGJlZm9yZSBzZXR1cCgpIGNhcHR1cmVzIHRoZSBzbmFwc2hvdFxuICAgICAgICBpZiAodGVhbW1hdGVPcHRzLnRlYW1tYXRlTW9kZSkge1xuICAgICAgICAgIGdldFRlYW1tYXRlTW9kZVNuYXBzaG90KCkuc2V0Q2xpVGVhbW1hdGVNb2RlT3ZlcnJpZGU/LihcbiAgICAgICAgICAgIHRlYW1tYXRlT3B0cy50ZWFtbWF0ZU1vZGUsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3QgcmVtb3RlIHNkayBvcHRpb25zXG4gICAgICBjb25zdCBzZGtVcmwgPSAob3B0aW9ucyBhcyB7IHNka1VybD86IHN0cmluZyB9KS5zZGtVcmwgPz8gdW5kZWZpbmVkXG5cbiAgICAgIC8vIEFsbG93IGVudiB2YXIgdG8gZW5hYmxlIHBhcnRpYWwgbWVzc2FnZXMgKHVzZWQgYnkgc2FuZGJveCBnYXRld2F5IGZvciBiYWt1KVxuICAgICAgY29uc3QgZWZmZWN0aXZlSW5jbHVkZVBhcnRpYWxNZXNzYWdlcyA9XG4gICAgICAgIGluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMgfHxcbiAgICAgICAgaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfSU5DTFVERV9QQVJUSUFMX01FU1NBR0VTKVxuXG4gICAgICAvLyBFbmFibGUgYWxsIGhvb2sgZXZlbnQgdHlwZXMgd2hlbiBleHBsaWNpdGx5IHJlcXVlc3RlZCB2aWEgU0RLIG9wdGlvblxuICAgICAgLy8gb3Igd2hlbiBydW5uaW5nIGluIENMQVVERV9DT0RFX1JFTU9URSBtb2RlIChDQ1IgbmVlZHMgdGhlbSkuXG4gICAgICAvLyBXaXRob3V0IHRoaXMsIG9ubHkgU2Vzc2lvblN0YXJ0IGFuZCBTZXR1cCBldmVudHMgYXJlIGVtaXR0ZWQuXG4gICAgICBpZiAoaW5jbHVkZUhvb2tFdmVudHMgfHwgaXNFbnZUcnV0aHkocHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfUkVNT1RFKSkge1xuICAgICAgICBzZXRBbGxIb29rRXZlbnRzRW5hYmxlZCh0cnVlKVxuICAgICAgfVxuXG4gICAgICAvLyBBdXRvLXNldCBpbnB1dC9vdXRwdXQgZm9ybWF0cywgdmVyYm9zZSBtb2RlLCBhbmQgcHJpbnQgbW9kZSB3aGVuIFNESyBVUkwgaXMgcHJvdmlkZWRcbiAgICAgIGlmIChzZGtVcmwpIHtcbiAgICAgICAgLy8gSWYgU0RLIFVSTCBpcyBwcm92aWRlZCwgYXV0b21hdGljYWxseSB1c2Ugc3RyZWFtLWpzb24gZm9ybWF0cyB1bmxlc3MgZXhwbGljaXRseSBzZXRcbiAgICAgICAgaWYgKCFpbnB1dEZvcm1hdCkge1xuICAgICAgICAgIGlucHV0Rm9ybWF0ID0gJ3N0cmVhbS1qc29uJ1xuICAgICAgICB9XG4gICAgICAgIGlmICghb3V0cHV0Rm9ybWF0KSB7XG4gICAgICAgICAgb3V0cHV0Rm9ybWF0ID0gJ3N0cmVhbS1qc29uJ1xuICAgICAgICB9XG4gICAgICAgIC8vIEF1dG8tZW5hYmxlIHZlcmJvc2UgbW9kZSB1bmxlc3MgZXhwbGljaXRseSBkaXNhYmxlZCBvciBhbHJlYWR5IHNldFxuICAgICAgICBpZiAob3B0aW9ucy52ZXJib3NlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB2ZXJib3NlID0gdHJ1ZVxuICAgICAgICB9XG4gICAgICAgIC8vIEF1dG8tZW5hYmxlIHByaW50IG1vZGUgdW5sZXNzIGV4cGxpY2l0bHkgZGlzYWJsZWRcbiAgICAgICAgaWYgKCFvcHRpb25zLnByaW50KSB7XG4gICAgICAgICAgcHJpbnQgPSB0cnVlXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRXh0cmFjdCB0ZWxlcG9ydCBvcHRpb25cbiAgICAgIGNvbnN0IHRlbGVwb3J0ID1cbiAgICAgICAgKG9wdGlvbnMgYXMgeyB0ZWxlcG9ydD86IHN0cmluZyB8IHRydWUgfSkudGVsZXBvcnQgPz8gbnVsbFxuXG4gICAgICAvLyBFeHRyYWN0IHJlbW90ZSBvcHRpb24gKGNhbiBiZSB0cnVlIGlmIG5vIGRlc2NyaXB0aW9uIHByb3ZpZGVkLCBvciBhIHN0cmluZylcbiAgICAgIGNvbnN0IHJlbW90ZU9wdGlvbiA9IChvcHRpb25zIGFzIHsgcmVtb3RlPzogc3RyaW5nIHwgdHJ1ZSB9KS5yZW1vdGVcbiAgICAgIGNvbnN0IHJlbW90ZSA9IHJlbW90ZU9wdGlvbiA9PT0gdHJ1ZSA/ICcnIDogKHJlbW90ZU9wdGlvbiA/PyBudWxsKVxuXG4gICAgICAvLyBFeHRyYWN0IC0tcmVtb3RlLWNvbnRyb2wgLyAtLXJjIGZsYWcgKGVuYWJsZSBicmlkZ2UgaW4gaW50ZXJhY3RpdmUgc2Vzc2lvbilcbiAgICAgIGNvbnN0IHJlbW90ZUNvbnRyb2xPcHRpb24gPVxuICAgICAgICAob3B0aW9ucyBhcyB7IHJlbW90ZUNvbnRyb2w/OiBzdHJpbmcgfCB0cnVlIH0pLnJlbW90ZUNvbnRyb2wgPz9cbiAgICAgICAgKG9wdGlvbnMgYXMgeyByYz86IHN0cmluZyB8IHRydWUgfSkucmNcbiAgICAgIC8vIEFjdHVhbCBicmlkZ2UgY2hlY2sgaXMgZGVmZXJyZWQgdG8gYWZ0ZXIgc2hvd1NldHVwU2NyZWVucygpIHNvIHRoYXRcbiAgICAgIC8vIHRydXN0IGlzIGVzdGFibGlzaGVkIGFuZCBHcm93dGhCb29rIGhhcyBhdXRoIGhlYWRlcnMuXG4gICAgICBsZXQgcmVtb3RlQ29udHJvbCA9IGZhbHNlXG4gICAgICBjb25zdCByZW1vdGVDb250cm9sTmFtZSA9XG4gICAgICAgIHR5cGVvZiByZW1vdGVDb250cm9sT3B0aW9uID09PSAnc3RyaW5nJyAmJlxuICAgICAgICByZW1vdGVDb250cm9sT3B0aW9uLmxlbmd0aCA+IDBcbiAgICAgICAgICA/IHJlbW90ZUNvbnRyb2xPcHRpb25cbiAgICAgICAgICA6IHVuZGVmaW5lZFxuXG4gICAgICAvLyBWYWxpZGF0ZSBzZXNzaW9uIElEIGlmIHByb3ZpZGVkXG4gICAgICBpZiAoc2Vzc2lvbklkKSB7XG4gICAgICAgIC8vIENoZWNrIGZvciBjb25mbGljdGluZyBmbGFnc1xuICAgICAgICAvLyAtLXNlc3Npb24taWQgY2FuIGJlIHVzZWQgd2l0aCAtLWNvbnRpbnVlIG9yIC0tcmVzdW1lIHdoZW4gLS1mb3JrLXNlc3Npb24gaXMgYWxzbyBwcm92aWRlZFxuICAgICAgICAvLyAodG8gc3BlY2lmeSBhIGN1c3RvbSBJRCBmb3IgdGhlIGZvcmtlZCBzZXNzaW9uKVxuICAgICAgICBpZiAoKG9wdGlvbnMuY29udGludWUgfHwgb3B0aW9ucy5yZXN1bWUpICYmICFvcHRpb25zLmZvcmtTZXNzaW9uKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdFcnJvcjogLS1zZXNzaW9uLWlkIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCAtLWNvbnRpbnVlIG9yIC0tcmVzdW1lIGlmIC0tZm9yay1zZXNzaW9uIGlzIGFsc28gc3BlY2lmaWVkLlxcbicsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFdoZW4gLS1zZGstdXJsIGlzIHByb3ZpZGVkIChicmlkZ2UvcmVtb3RlIG1vZGUpLCB0aGUgc2Vzc2lvbiBJRCBpcyBhXG4gICAgICAgIC8vIHNlcnZlci1hc3NpZ25lZCB0YWdnZWQgSUQgKGUuZy4gXCJzZXNzaW9uX2xvY2FsXzAxLi4uXCIpIHJhdGhlciB0aGFuIGFcbiAgICAgICAgLy8gVVVJRC4gU2tpcCBVVUlEIHZhbGlkYXRpb24gYW5kIGxvY2FsIGV4aXN0ZW5jZSBjaGVja3MgaW4gdGhhdCBjYXNlLlxuICAgICAgICBpZiAoIXNka1VybCkge1xuICAgICAgICAgIGNvbnN0IHZhbGlkYXRlZFNlc3Npb25JZCA9IHZhbGlkYXRlVXVpZChzZXNzaW9uSWQpXG4gICAgICAgICAgaWYgKCF2YWxpZGF0ZWRTZXNzaW9uSWQpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBjaGFsay5yZWQoJ0Vycm9yOiBJbnZhbGlkIHNlc3Npb24gSUQuIE11c3QgYmUgYSB2YWxpZCBVVUlELlxcbicpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQ2hlY2sgaWYgc2Vzc2lvbiBJRCBhbHJlYWR5IGV4aXN0c1xuICAgICAgICAgIGlmIChzZXNzaW9uSWRFeGlzdHModmFsaWRhdGVkU2Vzc2lvbklkKSkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICBgRXJyb3I6IFNlc3Npb24gSUQgJHt2YWxpZGF0ZWRTZXNzaW9uSWR9IGlzIGFscmVhZHkgaW4gdXNlLlxcbmAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRG93bmxvYWQgZmlsZSByZXNvdXJjZXMgaWYgc3BlY2lmaWVkIHZpYSAtLWZpbGUgZmxhZ1xuICAgICAgY29uc3QgZmlsZVNwZWNzID0gKG9wdGlvbnMgYXMgeyBmaWxlPzogc3RyaW5nW10gfSkuZmlsZVxuICAgICAgaWYgKGZpbGVTcGVjcyAmJiBmaWxlU3BlY3MubGVuZ3RoID4gMCkge1xuICAgICAgICAvLyBHZXQgc2Vzc2lvbiBpbmdyZXNzIHRva2VuIChwcm92aWRlZCBieSBFbnZNYW5hZ2VyIHZpYSBDTEFVREVfQ09ERV9TRVNTSU9OX0FDQ0VTU19UT0tFTilcbiAgICAgICAgY29uc3Qgc2Vzc2lvblRva2VuID0gZ2V0U2Vzc2lvbkluZ3Jlc3NBdXRoVG9rZW4oKVxuICAgICAgICBpZiAoIXNlc3Npb25Ub2tlbikge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAnRXJyb3I6IFNlc3Npb24gdG9rZW4gcmVxdWlyZWQgZm9yIGZpbGUgZG93bmxvYWRzLiBDTEFVREVfQ09ERV9TRVNTSU9OX0FDQ0VTU19UT0tFTiBtdXN0IGJlIHNldC5cXG4nLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBSZXNvbHZlIHNlc3Npb24gSUQ6IHByZWZlciByZW1vdGUgc2Vzc2lvbiBJRCwgZmFsbCBiYWNrIHRvIGludGVybmFsIHNlc3Npb24gSURcbiAgICAgICAgY29uc3QgZmlsZVNlc3Npb25JZCA9XG4gICAgICAgICAgcHJvY2Vzcy5lbnYuQ0xBVURFX0NPREVfUkVNT1RFX1NFU1NJT05fSUQgfHwgZ2V0U2Vzc2lvbklkKClcblxuICAgICAgICBjb25zdCBmaWxlcyA9IHBhcnNlRmlsZVNwZWNzKGZpbGVTcGVjcylcbiAgICAgICAgaWYgKGZpbGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAvLyBVc2UgQU5USFJPUElDX0JBU0VfVVJMIGlmIHNldCAoYnkgRW52TWFuYWdlciksIG90aGVyd2lzZSB1c2UgT0F1dGggY29uZmlnXG4gICAgICAgICAgLy8gVGhpcyBlbnN1cmVzIGNvbnNpc3RlbmN5IHdpdGggc2Vzc2lvbiBpbmdyZXNzIEFQSSBpbiBhbGwgZW52aXJvbm1lbnRzXG4gICAgICAgICAgY29uc3QgY29uZmlnOiBGaWxlc0FwaUNvbmZpZyA9IHtcbiAgICAgICAgICAgIGJhc2VVcmw6XG4gICAgICAgICAgICAgIHByb2Nlc3MuZW52LkFOVEhST1BJQ19CQVNFX1VSTCB8fCBnZXRPYXV0aENvbmZpZygpLkJBU0VfQVBJX1VSTCxcbiAgICAgICAgICAgIG9hdXRoVG9rZW46IHNlc3Npb25Ub2tlbixcbiAgICAgICAgICAgIHNlc3Npb25JZDogZmlsZVNlc3Npb25JZCxcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBTdGFydCBkb3dubG9hZCB3aXRob3V0IGJsb2NraW5nIHN0YXJ0dXAgLSBhd2FpdCBiZWZvcmUgUkVQTCByZW5kZXJzXG4gICAgICAgICAgZmlsZURvd25sb2FkUHJvbWlzZSA9IGRvd25sb2FkU2Vzc2lvbkZpbGVzKGZpbGVzLCBjb25maWcpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gR2V0IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uIGZyb20gc3RhdGUgKHdhcyBzZXQgYmVmb3JlIGluaXQoKSlcbiAgICAgIGNvbnN0IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uID0gZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24oKVxuXG4gICAgICAvLyBWYWxpZGF0ZSB0aGF0IGZhbGxiYWNrIG1vZGVsIGlzIGRpZmZlcmVudCBmcm9tIG1haW4gbW9kZWxcbiAgICAgIGlmIChmYWxsYmFja01vZGVsICYmIG9wdGlvbnMubW9kZWwgJiYgZmFsbGJhY2tNb2RlbCA9PT0gb3B0aW9ucy5tb2RlbCkge1xuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAnRXJyb3I6IEZhbGxiYWNrIG1vZGVsIGNhbm5vdCBiZSB0aGUgc2FtZSBhcyB0aGUgbWFpbiBtb2RlbC4gUGxlYXNlIHNwZWNpZnkgYSBkaWZmZXJlbnQgbW9kZWwgZm9yIC0tZmFsbGJhY2stbW9kZWwuXFxuJyxcbiAgICAgICAgICApLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfVxuXG4gICAgICAvLyBIYW5kbGUgc3lzdGVtIHByb21wdCBvcHRpb25zXG4gICAgICBsZXQgc3lzdGVtUHJvbXB0ID0gb3B0aW9ucy5zeXN0ZW1Qcm9tcHRcbiAgICAgIGlmIChvcHRpb25zLnN5c3RlbVByb21wdEZpbGUpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMuc3lzdGVtUHJvbXB0KSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdFcnJvcjogQ2Fubm90IHVzZSBib3RoIC0tc3lzdGVtLXByb21wdCBhbmQgLS1zeXN0ZW0tcHJvbXB0LWZpbGUuIFBsZWFzZSB1c2Ugb25seSBvbmUuXFxuJyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCBmaWxlUGF0aCA9IHJlc29sdmUob3B0aW9ucy5zeXN0ZW1Qcm9tcHRGaWxlKVxuICAgICAgICAgIHN5c3RlbVByb21wdCA9IHJlYWRGaWxlU3luYyhmaWxlUGF0aCwgJ3V0ZjgnKVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGNvbnN0IGNvZGUgPSBnZXRFcnJub0NvZGUoZXJyb3IpXG4gICAgICAgICAgaWYgKGNvZGUgPT09ICdFTk9FTlQnKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAgIGBFcnJvcjogU3lzdGVtIHByb21wdCBmaWxlIG5vdCBmb3VuZDogJHtyZXNvbHZlKG9wdGlvbnMuc3lzdGVtUHJvbXB0RmlsZSl9XFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgYEVycm9yIHJlYWRpbmcgc3lzdGVtIHByb21wdCBmaWxlOiAke2Vycm9yTWVzc2FnZShlcnJvcil9XFxuYCxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEhhbmRsZSBhcHBlbmQgc3lzdGVtIHByb21wdCBvcHRpb25zXG4gICAgICBsZXQgYXBwZW5kU3lzdGVtUHJvbXB0ID0gb3B0aW9ucy5hcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgIGlmIChvcHRpb25zLmFwcGVuZFN5c3RlbVByb21wdEZpbGUpIHtcbiAgICAgICAgaWYgKG9wdGlvbnMuYXBwZW5kU3lzdGVtUHJvbXB0KSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdFcnJvcjogQ2Fubm90IHVzZSBib3RoIC0tYXBwZW5kLXN5c3RlbS1wcm9tcHQgYW5kIC0tYXBwZW5kLXN5c3RlbS1wcm9tcHQtZmlsZS4gUGxlYXNlIHVzZSBvbmx5IG9uZS5cXG4nLFxuICAgICAgICAgICAgKSxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IGZpbGVQYXRoID0gcmVzb2x2ZShvcHRpb25zLmFwcGVuZFN5c3RlbVByb21wdEZpbGUpXG4gICAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0ID0gcmVhZEZpbGVTeW5jKGZpbGVQYXRoLCAndXRmOCcpXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgY29uc3QgY29kZSA9IGdldEVycm5vQ29kZShlcnJvcilcbiAgICAgICAgICBpZiAoY29kZSA9PT0gJ0VOT0VOVCcpIHtcbiAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICAgYEVycm9yOiBBcHBlbmQgc3lzdGVtIHByb21wdCBmaWxlIG5vdCBmb3VuZDogJHtyZXNvbHZlKG9wdGlvbnMuYXBwZW5kU3lzdGVtUHJvbXB0RmlsZSl9XFxuYCxcbiAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICAgIH1cbiAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgYEVycm9yIHJlYWRpbmcgYXBwZW5kIHN5c3RlbSBwcm9tcHQgZmlsZTogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfVxcbmAsXG4gICAgICAgICAgICApLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgdGVhbW1hdGUtc3BlY2lmaWMgc3lzdGVtIHByb21wdCBhZGRlbmR1bSBmb3IgdG11eCB0ZWFtbWF0ZXNcbiAgICAgIGlmIChcbiAgICAgICAgaXNBZ2VudFN3YXJtc0VuYWJsZWQoKSAmJlxuICAgICAgICBzdG9yZWRUZWFtbWF0ZU9wdHM/LmFnZW50SWQgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy5hZ2VudE5hbWUgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy50ZWFtTmFtZVxuICAgICAgKSB7XG4gICAgICAgIGNvbnN0IGFkZGVuZHVtID1cbiAgICAgICAgICBnZXRUZWFtbWF0ZVByb21wdEFkZGVuZHVtKCkuVEVBTU1BVEVfU1lTVEVNX1BST01QVF9BRERFTkRVTVxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICA/IGAke2FwcGVuZFN5c3RlbVByb21wdH1cXG5cXG4ke2FkZGVuZHVtfWBcbiAgICAgICAgICA6IGFkZGVuZHVtXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHsgbW9kZTogcGVybWlzc2lvbk1vZGUsIG5vdGlmaWNhdGlvbjogcGVybWlzc2lvbk1vZGVOb3RpZmljYXRpb24gfSA9XG4gICAgICAgIGluaXRpYWxQZXJtaXNzaW9uTW9kZUZyb21DTEkoe1xuICAgICAgICAgIHBlcm1pc3Npb25Nb2RlQ2xpLFxuICAgICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICB9KVxuXG4gICAgICAvLyBTdG9yZSBzZXNzaW9uIGJ5cGFzcyBwZXJtaXNzaW9ucyBtb2RlIGZvciB0cnVzdCBkaWFsb2cgY2hlY2tcbiAgICAgIHNldFNlc3Npb25CeXBhc3NQZXJtaXNzaW9uc01vZGUocGVybWlzc2lvbk1vZGUgPT09ICdieXBhc3NQZXJtaXNzaW9ucycpXG4gICAgICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICAgICAgLy8gYXV0b01vZGVGbGFnQ2xpIGlzIHRoZSBcImRpZCB0aGUgdXNlciBpbnRlbmQgYXV0byB0aGlzIHNlc3Npb25cIiBzaWduYWwuXG4gICAgICAgIC8vIFNldCB3aGVuOiAtLWVuYWJsZS1hdXRvLW1vZGUsIC0tcGVybWlzc2lvbi1tb2RlIGF1dG8sIHJlc29sdmVkIG1vZGVcbiAgICAgICAgLy8gaXMgYXV0bywgT1Igc2V0dGluZ3MgZGVmYXVsdE1vZGUgaXMgYXV0byBidXQgdGhlIGdhdGUgZGVuaWVkIGl0XG4gICAgICAgIC8vIChwZXJtaXNzaW9uTW9kZSByZXNvbHZlZCB0byBkZWZhdWx0IHdpdGggbm8gZXhwbGljaXQgQ0xJIG92ZXJyaWRlKS5cbiAgICAgICAgLy8gVXNlZCBieSB2ZXJpZnlBdXRvTW9kZUdhdGVBY2Nlc3MgdG8gZGVjaWRlIHdoZXRoZXIgdG8gbm90aWZ5IG9uXG4gICAgICAgIC8vIGF1dG8tdW5hdmFpbGFibGUsIGFuZCBieSB0ZW5ndV9hdXRvX21vZGVfY29uZmlnIG9wdC1pbiBjYXJvdXNlbC5cbiAgICAgICAgaWYgKFxuICAgICAgICAgIChvcHRpb25zIGFzIHsgZW5hYmxlQXV0b01vZGU/OiBib29sZWFuIH0pLmVuYWJsZUF1dG9Nb2RlIHx8XG4gICAgICAgICAgcGVybWlzc2lvbk1vZGVDbGkgPT09ICdhdXRvJyB8fFxuICAgICAgICAgIHBlcm1pc3Npb25Nb2RlID09PSAnYXV0bycgfHxcbiAgICAgICAgICAoIXBlcm1pc3Npb25Nb2RlQ2xpICYmIGlzRGVmYXVsdFBlcm1pc3Npb25Nb2RlQXV0bygpKVxuICAgICAgICApIHtcbiAgICAgICAgICBhdXRvTW9kZVN0YXRlTW9kdWxlPy5zZXRBdXRvTW9kZUZsYWdDbGkodHJ1ZSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBQYXJzZSB0aGUgTUNQIGNvbmZpZyBmaWxlcy9zdHJpbmdzIGlmIHByb3ZpZGVkXG4gICAgICBsZXQgZHluYW1pY01jcENvbmZpZzogUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPiA9IHt9XG5cbiAgICAgIGlmIChtY3BDb25maWcgJiYgbWNwQ29uZmlnLmxlbmd0aCA+IDApIHtcbiAgICAgICAgLy8gUHJvY2VzcyBtY3BDb25maWcgYXJyYXlcbiAgICAgICAgY29uc3QgcHJvY2Vzc2VkQ29uZmlncyA9IG1jcENvbmZpZ1xuICAgICAgICAgIC5tYXAoY29uZmlnID0+IGNvbmZpZy50cmltKCkpXG4gICAgICAgICAgLmZpbHRlcihjb25maWcgPT4gY29uZmlnLmxlbmd0aCA+IDApXG5cbiAgICAgICAgbGV0IGFsbENvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIE1jcFNlcnZlckNvbmZpZz4gPSB7fVxuICAgICAgICBjb25zdCBhbGxFcnJvcnM6IFZhbGlkYXRpb25FcnJvcltdID0gW11cblxuICAgICAgICBmb3IgKGNvbnN0IGNvbmZpZ0l0ZW0gb2YgcHJvY2Vzc2VkQ29uZmlncykge1xuICAgICAgICAgIGxldCBjb25maWdzOiBSZWNvcmQ8c3RyaW5nLCBNY3BTZXJ2ZXJDb25maWc+IHwgbnVsbCA9IG51bGxcbiAgICAgICAgICBsZXQgZXJyb3JzOiBWYWxpZGF0aW9uRXJyb3JbXSA9IFtdXG5cbiAgICAgICAgICAvLyBGaXJzdCB0cnkgdG8gcGFyc2UgYXMgSlNPTiBzdHJpbmdcbiAgICAgICAgICBjb25zdCBwYXJzZWRKc29uID0gc2FmZVBhcnNlSlNPTihjb25maWdJdGVtKVxuICAgICAgICAgIGlmIChwYXJzZWRKc29uKSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBwYXJzZU1jcENvbmZpZyh7XG4gICAgICAgICAgICAgIGNvbmZpZ09iamVjdDogcGFyc2VkSnNvbixcbiAgICAgICAgICAgICAgZmlsZVBhdGg6ICdjb21tYW5kIGxpbmUnLFxuICAgICAgICAgICAgICBleHBhbmRWYXJzOiB0cnVlLFxuICAgICAgICAgICAgICBzY29wZTogJ2R5bmFtaWMnLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICAgIGlmIChyZXN1bHQuY29uZmlnKSB7XG4gICAgICAgICAgICAgIGNvbmZpZ3MgPSByZXN1bHQuY29uZmlnLm1jcFNlcnZlcnNcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGVycm9ycyA9IHJlc3VsdC5lcnJvcnNcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gVHJ5IGFzIGZpbGUgcGF0aFxuICAgICAgICAgICAgY29uc3QgY29uZmlnUGF0aCA9IHJlc29sdmUoY29uZmlnSXRlbSlcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IHBhcnNlTWNwQ29uZmlnRnJvbUZpbGVQYXRoKHtcbiAgICAgICAgICAgICAgZmlsZVBhdGg6IGNvbmZpZ1BhdGgsXG4gICAgICAgICAgICAgIGV4cGFuZFZhcnM6IHRydWUsXG4gICAgICAgICAgICAgIHNjb3BlOiAnZHluYW1pYycsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgaWYgKHJlc3VsdC5jb25maWcpIHtcbiAgICAgICAgICAgICAgY29uZmlncyA9IHJlc3VsdC5jb25maWcubWNwU2VydmVyc1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgZXJyb3JzID0gcmVzdWx0LmVycm9yc1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChlcnJvcnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgYWxsRXJyb3JzLnB1c2goLi4uZXJyb3JzKVxuICAgICAgICAgIH0gZWxzZSBpZiAoY29uZmlncykge1xuICAgICAgICAgICAgLy8gTWVyZ2UgY29uZmlncywgbGF0ZXIgb25lcyBvdmVycmlkZSBlYXJsaWVyIG9uZXNcbiAgICAgICAgICAgIGFsbENvbmZpZ3MgPSB7IC4uLmFsbENvbmZpZ3MsIC4uLmNvbmZpZ3MgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhbGxFcnJvcnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgIGNvbnN0IGZvcm1hdHRlZEVycm9ycyA9IGFsbEVycm9yc1xuICAgICAgICAgICAgLm1hcChlcnIgPT4gYCR7ZXJyLnBhdGggPyBlcnIucGF0aCArICc6ICcgOiAnJ30ke2Vyci5tZXNzYWdlfWApXG4gICAgICAgICAgICAuam9pbignXFxuJylcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgLS1tY3AtY29uZmlnIHZhbGlkYXRpb24gZmFpbGVkICgke2FsbEVycm9ycy5sZW5ndGh9IGVycm9ycyk6ICR7Zm9ybWF0dGVkRXJyb3JzfWAsXG4gICAgICAgICAgICB7IGxldmVsOiAnZXJyb3InIH0sXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgYEVycm9yOiBJbnZhbGlkIE1DUCBjb25maWd1cmF0aW9uOlxcbiR7Zm9ybWF0dGVkRXJyb3JzfVxcbmAsXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKE9iamVjdC5rZXlzKGFsbENvbmZpZ3MpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAvLyBTREsgaG9zdHMgKE5lc3QvRGVza3RvcCkgb3duIHRoZWlyIHNlcnZlciBuYW1pbmcgYW5kIG1heSByZXVzZVxuICAgICAgICAgIC8vIGJ1aWx0LWluIG5hbWVzIFx1MjAxNCBza2lwIHJlc2VydmVkLW5hbWUgY2hlY2tzIGZvciB0eXBlOidzZGsnLlxuICAgICAgICAgIGNvbnN0IG5vblNka0NvbmZpZ05hbWVzID0gT2JqZWN0LmVudHJpZXMoYWxsQ29uZmlncylcbiAgICAgICAgICAgIC5maWx0ZXIoKFssIGNvbmZpZ10pID0+IGNvbmZpZy50eXBlICE9PSAnc2RrJylcbiAgICAgICAgICAgIC5tYXAoKFtuYW1lXSkgPT4gbmFtZSlcblxuICAgICAgICAgIGxldCByZXNlcnZlZE5hbWVFcnJvcjogc3RyaW5nIHwgbnVsbCA9IG51bGxcbiAgICAgICAgICBpZiAobm9uU2RrQ29uZmlnTmFtZXMuc29tZShpc0NsYXVkZUluQ2hyb21lTUNQU2VydmVyKSkge1xuICAgICAgICAgICAgcmVzZXJ2ZWROYW1lRXJyb3IgPSBgSW52YWxpZCBNQ1AgY29uZmlndXJhdGlvbjogXCIke0NMQVVERV9JTl9DSFJPTUVfTUNQX1NFUlZFUl9OQU1FfVwiIGlzIGEgcmVzZXJ2ZWQgTUNQIG5hbWUuYFxuICAgICAgICAgIH0gZWxzZSBpZiAoZmVhdHVyZSgnQ0hJQ0FHT19NQ1AnKSkge1xuICAgICAgICAgICAgY29uc3QgeyBpc0NvbXB1dGVyVXNlTUNQU2VydmVyLCBDT01QVVRFUl9VU0VfTUNQX1NFUlZFUl9OQU1FIH0gPVxuICAgICAgICAgICAgICBhd2FpdCBpbXBvcnQoJ3NyYy91dGlscy9jb21wdXRlclVzZS9jb21tb24uanMnKVxuICAgICAgICAgICAgaWYgKG5vblNka0NvbmZpZ05hbWVzLnNvbWUoaXNDb21wdXRlclVzZU1DUFNlcnZlcikpIHtcbiAgICAgICAgICAgICAgcmVzZXJ2ZWROYW1lRXJyb3IgPSBgSW52YWxpZCBNQ1AgY29uZmlndXJhdGlvbjogXCIke0NPTVBVVEVSX1VTRV9NQ1BfU0VSVkVSX05BTUV9XCIgaXMgYSByZXNlcnZlZCBNQ1AgbmFtZS5gXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChyZXNlcnZlZE5hbWVFcnJvcikge1xuICAgICAgICAgICAgLy8gc3RkZXJyK2V4aXQoMSkgXHUyMDE0IGEgdGhyb3cgaGVyZSBiZWNvbWVzIGEgc2lsZW50IHVuaGFuZGxlZFxuICAgICAgICAgICAgLy8gcmVqZWN0aW9uIGluIHN0cmVhbS1qc29uIG1vZGUgKHZvaWQgbWFpbigpIGluIGNsaS50c3gpLlxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYEVycm9yOiAke3Jlc2VydmVkTmFtZUVycm9yfVxcbmApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBBZGQgZHluYW1pYyBzY29wZSB0byBhbGwgY29uZmlncy4gdHlwZTonc2RrJyBlbnRyaWVzIHBhc3MgdGhyb3VnaFxuICAgICAgICAgIC8vIHVuY2hhbmdlZCBcdTIwMTQgdGhleSdyZSBleHRyYWN0ZWQgaW50byBzZGtNY3BDb25maWdzIGRvd25zdHJlYW0gYW5kXG4gICAgICAgICAgLy8gcGFzc2VkIHRvIHByaW50LnRzLiBUaGUgUHl0aG9uIFNESyByZWxpZXMgb24gdGhpcyBwYXRoIChpdCBkb2Vzbid0XG4gICAgICAgICAgLy8gc2VuZCBzZGtNY3BTZXJ2ZXJzIGluIHRoZSBpbml0aWFsaXplIG1lc3NhZ2UpLiBEcm9wcGluZyB0aGVtIGhlcmVcbiAgICAgICAgICAvLyBicm9rZSBDb3dvcmtlciAoaW5jLTUxMjIpLiBUaGUgcG9saWN5IGZpbHRlciBiZWxvdyBhbHJlYWR5IGV4ZW1wdHNcbiAgICAgICAgICAvLyB0eXBlOidzZGsnLCBhbmQgdGhlIGVudHJpZXMgYXJlIGluZXJ0IHdpdGhvdXQgYW4gU0RLIHRyYW5zcG9ydCBvblxuICAgICAgICAgIC8vIHN0ZGluLCBzbyB0aGVyZSdzIG5vIGJ5cGFzcyByaXNrIGZyb20gbGV0dGluZyB0aGVtIHRocm91Z2guXG4gICAgICAgICAgY29uc3Qgc2NvcGVkQ29uZmlncyA9IG1hcFZhbHVlcyhhbGxDb25maWdzLCBjb25maWcgPT4gKHtcbiAgICAgICAgICAgIC4uLmNvbmZpZyxcbiAgICAgICAgICAgIHNjb3BlOiAnZHluYW1pYycgYXMgY29uc3QsXG4gICAgICAgICAgfSkpXG5cbiAgICAgICAgICAvLyBFbmZvcmNlIG1hbmFnZWQgcG9saWN5IChhbGxvd2VkTWNwU2VydmVycyAvIGRlbmllZE1jcFNlcnZlcnMpIG9uXG4gICAgICAgICAgLy8gLS1tY3AtY29uZmlnIHNlcnZlcnMuIFdpdGhvdXQgdGhpcywgdGhlIENMSSBmbGFnIGJ5cGFzc2VzIHRoZVxuICAgICAgICAgIC8vIGVudGVycHJpc2UgYWxsb3dsaXN0IHRoYXQgdXNlci9wcm9qZWN0L2xvY2FsIGNvbmZpZ3MgZ28gdGhyb3VnaCBpblxuICAgICAgICAgIC8vIGdldENsYXVkZUNvZGVNY3BDb25maWdzIFx1MjAxNCBjYWxsZXJzIHNwcmVhZCBkeW5hbWljTWNwQ29uZmlnIGJhY2sgb25cbiAgICAgICAgICAvLyB0b3Agb2YgZmlsdGVyZWQgcmVzdWx0cy4gRmlsdGVyIGhlcmUgYXQgdGhlIHNvdXJjZSBzbyBhbGxcbiAgICAgICAgICAvLyBkb3duc3RyZWFtIGNvbnN1bWVycyBzZWUgdGhlIHBvbGljeS1maWx0ZXJlZCBzZXQuXG4gICAgICAgICAgY29uc3QgeyBhbGxvd2VkLCBibG9ja2VkIH0gPSBmaWx0ZXJNY3BTZXJ2ZXJzQnlQb2xpY3koc2NvcGVkQ29uZmlncylcbiAgICAgICAgICBpZiAoYmxvY2tlZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgYFdhcm5pbmc6IE1DUCAke3BsdXJhbChibG9ja2VkLmxlbmd0aCwgJ3NlcnZlcicpfSBibG9ja2VkIGJ5IGVudGVycHJpc2UgcG9saWN5OiAke2Jsb2NrZWQuam9pbignLCAnKX1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgICBkeW5hbWljTWNwQ29uZmlnID0geyAuLi5keW5hbWljTWNwQ29uZmlnLCAuLi5hbGxvd2VkIH1cbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBFeHRyYWN0IENsYXVkZSBpbiBDaHJvbWUgb3B0aW9uIGFuZCBlbmZvcmNlIGNsYXVkZS5haSBzdWJzY3JpYmVyIGNoZWNrICh1bmxlc3MgdXNlciBpcyBhbnQpXG4gICAgICBjb25zdCBjaHJvbWVPcHRzID0gb3B0aW9ucyBhcyB7IGNocm9tZT86IGJvb2xlYW4gfVxuICAgICAgLy8gU3RvcmUgdGhlIGV4cGxpY2l0IENMSSBmbGFnIHNvIHRlYW1tYXRlcyBjYW4gaW5oZXJpdCBpdFxuICAgICAgc2V0Q2hyb21lRmxhZ092ZXJyaWRlKGNocm9tZU9wdHMuY2hyb21lKVxuICAgICAgY29uc3QgZW5hYmxlQ2xhdWRlSW5DaHJvbWUgPVxuICAgICAgICBzaG91bGRFbmFibGVDbGF1ZGVJbkNocm9tZShjaHJvbWVPcHRzLmNocm9tZSkgJiZcbiAgICAgICAgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcgfHwgaXNDbGF1ZGVBSVN1YnNjcmliZXIoKSlcbiAgICAgIGNvbnN0IGF1dG9FbmFibGVDbGF1ZGVJbkNocm9tZSA9XG4gICAgICAgICFlbmFibGVDbGF1ZGVJbkNocm9tZSAmJiBzaG91bGRBdXRvRW5hYmxlQ2xhdWRlSW5DaHJvbWUoKVxuXG4gICAgICBpZiAoZW5hYmxlQ2xhdWRlSW5DaHJvbWUpIHtcbiAgICAgICAgY29uc3QgcGxhdGZvcm0gPSBnZXRQbGF0Zm9ybSgpXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NsYXVkZV9pbl9jaHJvbWVfc2V0dXAnLCB7XG4gICAgICAgICAgICBwbGF0Zm9ybTpcbiAgICAgICAgICAgICAgcGxhdGZvcm0gYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICB9KVxuXG4gICAgICAgICAgY29uc3Qge1xuICAgICAgICAgICAgbWNwQ29uZmlnOiBjaHJvbWVNY3BDb25maWcsXG4gICAgICAgICAgICBhbGxvd2VkVG9vbHM6IGNocm9tZU1jcFRvb2xzLFxuICAgICAgICAgICAgc3lzdGVtUHJvbXB0OiBjaHJvbWVTeXN0ZW1Qcm9tcHQsXG4gICAgICAgICAgfSA9IHNldHVwQ2xhdWRlSW5DaHJvbWUoKVxuICAgICAgICAgIGR5bmFtaWNNY3BDb25maWcgPSB7IC4uLmR5bmFtaWNNY3BDb25maWcsIC4uLmNocm9tZU1jcENvbmZpZyB9XG4gICAgICAgICAgYWxsb3dlZFRvb2xzLnB1c2goLi4uY2hyb21lTWNwVG9vbHMpXG4gICAgICAgICAgaWYgKGNocm9tZVN5c3RlbVByb21wdCkge1xuICAgICAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0ID0gYXBwZW5kU3lzdGVtUHJvbXB0XG4gICAgICAgICAgICAgID8gYCR7Y2hyb21lU3lzdGVtUHJvbXB0fVxcblxcbiR7YXBwZW5kU3lzdGVtUHJvbXB0fWBcbiAgICAgICAgICAgICAgOiBjaHJvbWVTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NsYXVkZV9pbl9jaHJvbWVfc2V0dXBfZmFpbGVkJywge1xuICAgICAgICAgICAgcGxhdGZvcm06XG4gICAgICAgICAgICAgIHBsYXRmb3JtIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgfSlcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoYFtDbGF1ZGUgaW4gQ2hyb21lXSBFcnJvcjogJHtlcnJvcn1gKVxuICAgICAgICAgIGxvZ0Vycm9yKGVycm9yKVxuICAgICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvcjogRmFpbGVkIHRvIHJ1biB3aXRoIENsYXVkZSBpbiBDaHJvbWUuYClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIGlmIChhdXRvRW5hYmxlQ2xhdWRlSW5DaHJvbWUpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IG1jcENvbmZpZzogY2hyb21lTWNwQ29uZmlnIH0gPSBzZXR1cENsYXVkZUluQ2hyb21lKClcbiAgICAgICAgICBkeW5hbWljTWNwQ29uZmlnID0geyAuLi5keW5hbWljTWNwQ29uZmlnLCAuLi5jaHJvbWVNY3BDb25maWcgfVxuXG4gICAgICAgICAgY29uc3QgaGludCA9XG4gICAgICAgICAgICBmZWF0dXJlKCdXRUJfQlJPV1NFUl9UT09MJykgJiZcbiAgICAgICAgICAgIHR5cGVvZiBCdW4gIT09ICd1bmRlZmluZWQnICYmXG4gICAgICAgICAgICAnV2ViVmlldycgaW4gQnVuXG4gICAgICAgICAgICAgID8gQ0xBVURFX0lOX0NIUk9NRV9TS0lMTF9ISU5UX1dJVEhfV0VCQlJPV1NFUlxuICAgICAgICAgICAgICA6IENMQVVERV9JTl9DSFJPTUVfU0tJTExfSElOVFxuICAgICAgICAgIGFwcGVuZFN5c3RlbVByb21wdCA9IGFwcGVuZFN5c3RlbVByb21wdFxuICAgICAgICAgICAgPyBgJHthcHBlbmRTeXN0ZW1Qcm9tcHR9XFxuXFxuJHtoaW50fWBcbiAgICAgICAgICAgIDogaGludFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIC8vIFNpbGVudGx5IHNraXAgYW55IGVycm9ycyBmb3IgdGhlIGF1dG8tZW5hYmxlXG4gICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBbQ2xhdWRlIGluIENocm9tZV0gRXJyb3IgKGF1dG8tZW5hYmxlKTogJHtlcnJvcn1gKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIEV4dHJhY3Qgc3RyaWN0IE1DUCBjb25maWcgZmxhZ1xuICAgICAgY29uc3Qgc3RyaWN0TWNwQ29uZmlnID0gb3B0aW9ucy5zdHJpY3RNY3BDb25maWcgfHwgZmFsc2VcblxuICAgICAgLy8gQ2hlY2sgaWYgZW50ZXJwcmlzZSBNQ1AgY29uZmlndXJhdGlvbiBleGlzdHMuIFdoZW4gaXQgZG9lcywgb25seSBhbGxvdyBkeW5hbWljIE1DUFxuICAgICAgLy8gY29uZmlncyB0aGF0IGNvbnRhaW4gc3BlY2lhbCBzZXJ2ZXIgdHlwZXMgKHNkaylcbiAgICAgIGlmIChkb2VzRW50ZXJwcmlzZU1jcENvbmZpZ0V4aXN0KCkpIHtcbiAgICAgICAgaWYgKHN0cmljdE1jcENvbmZpZykge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKFxuICAgICAgICAgICAgY2hhbGsucmVkKFxuICAgICAgICAgICAgICAnWW91IGNhbm5vdCB1c2UgLS1zdHJpY3QtbWNwLWNvbmZpZyB3aGVuIGFuIGVudGVycHJpc2UgTUNQIGNvbmZpZyBpcyBwcmVzZW50JyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gRm9yIC0tbWNwLWNvbmZpZywgYWxsb3cgaWYgYWxsIHNlcnZlcnMgYXJlIGludGVybmFsIHR5cGVzIChzZGspXG4gICAgICAgIGlmIChcbiAgICAgICAgICBkeW5hbWljTWNwQ29uZmlnICYmXG4gICAgICAgICAgIWFyZU1jcENvbmZpZ3NBbGxvd2VkV2l0aEVudGVycHJpc2VNY3BDb25maWcoZHluYW1pY01jcENvbmZpZylcbiAgICAgICAgKSB7XG4gICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICdZb3UgY2Fubm90IGR5bmFtaWNhbGx5IGNvbmZpZ3VyZSBNQ1Agc2VydmVycyB3aGVuIGFuIGVudGVycHJpc2UgTUNQIGNvbmZpZyBpcyBwcmVzZW50JyxcbiAgICAgICAgICAgICksXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIGNoaWNhZ28gTUNQOiBndWFyZGVkIENvbXB1dGVyIFVzZSAoYXBwIGFsbG93bGlzdCArIGZyb250bW9zdCBnYXRlICtcbiAgICAgIC8vIFNDQ29udGVudEZpbHRlciBzY3JlZW5zaG90cykuIEFudC1vbmx5LCBHcm93dGhCb29rLWdhdGVkIFx1MjAxNCBmYWlsdXJlc1xuICAgICAgLy8gYXJlIHNpbGVudCAodGhpcyBpcyBkb2dmb29kaW5nKS4gUGxhdGZvcm0gKyBpbnRlcmFjdGl2ZSBjaGVja3MgaW5saW5lXG4gICAgICAvLyBzbyBub24tbWFjT1MgLyBwcmludC1tb2RlIGFudHMgc2tpcCB0aGUgaGVhdnkgQGFudC9jb21wdXRlci11c2UtbWNwXG4gICAgICAvLyBpbXBvcnQgZW50aXJlbHkuIGdhdGVzLmpzIGlzIGxpZ2h0ICh0eXBlLW9ubHkgcGFja2FnZSBpbXBvcnQpLlxuICAgICAgLy9cbiAgICAgIC8vIFBsYWNlZCBBRlRFUiB0aGUgZW50ZXJwcmlzZS1NQ1AtY29uZmlnIGNoZWNrOiB0aGF0IGNoZWNrIHJlamVjdHMgYW55XG4gICAgICAvLyBkeW5hbWljTWNwQ29uZmlnIGVudHJ5IHdpdGggYHR5cGUgIT09ICdzZGsnYCwgYW5kIG91ciBjb25maWcgaXNcbiAgICAgIC8vIGB0eXBlOiAnc3RkaW8nYC4gQW4gZW50ZXJwcmlzZS1jb25maWcgYW50IHdpdGggdGhlIEdCIGdhdGUgb24gd291bGRcbiAgICAgIC8vIG90aGVyd2lzZSBwcm9jZXNzLmV4aXQoMSkuIENocm9tZSBoYXMgdGhlIHNhbWUgbGF0ZW50IGlzc3VlIGJ1dCBoYXNcbiAgICAgIC8vIHNoaXBwZWQgd2l0aG91dCBpbmNpZGVudDsgY2hpY2FnbyBwbGFjZXMgaXRzZWxmIGNvcnJlY3RseS5cbiAgICAgIGlmIChcbiAgICAgICAgZmVhdHVyZSgnQ0hJQ0FHT19NQ1AnKSAmJlxuICAgICAgICBnZXRQbGF0Zm9ybSgpID09PSAnbWFjb3MnICYmXG4gICAgICAgICFnZXRJc05vbkludGVyYWN0aXZlU2Vzc2lvbigpXG4gICAgICApIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCB7IGdldENoaWNhZ29FbmFibGVkIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnc3JjL3V0aWxzL2NvbXB1dGVyVXNlL2dhdGVzLmpzJ1xuICAgICAgICAgIClcbiAgICAgICAgICBpZiAoZ2V0Q2hpY2Fnb0VuYWJsZWQoKSkge1xuICAgICAgICAgICAgY29uc3QgeyBzZXR1cENvbXB1dGVyVXNlTUNQIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAgICdzcmMvdXRpbHMvY29tcHV0ZXJVc2Uvc2V0dXAuanMnXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCB7IG1jcENvbmZpZywgYWxsb3dlZFRvb2xzOiBjdVRvb2xzIH0gPSBzZXR1cENvbXB1dGVyVXNlTUNQKClcbiAgICAgICAgICAgIGR5bmFtaWNNY3BDb25maWcgPSB7IC4uLmR5bmFtaWNNY3BDb25maWcsIC4uLm1jcENvbmZpZyB9XG4gICAgICAgICAgICBhbGxvd2VkVG9vbHMucHVzaCguLi5jdVRvb2xzKVxuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgW0NvbXB1dGVyIFVzZSBNQ1BdIFNldHVwIGZhaWxlZDogJHtlcnJvck1lc3NhZ2UoZXJyb3IpfWAsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFN0b3JlIGFkZGl0aW9uYWwgZGlyZWN0b3JpZXMgZm9yIENMQVVERS5tZCBsb2FkaW5nIChjb250cm9sbGVkIGJ5IGVudiB2YXIpXG4gICAgICBzZXRBZGRpdGlvbmFsRGlyZWN0b3JpZXNGb3JDbGF1ZGVNZChhZGREaXIpXG5cbiAgICAgIC8vIENoYW5uZWwgc2VydmVyIGFsbG93bGlzdCBmcm9tIC0tY2hhbm5lbHMgZmxhZyBcdTIwMTQgc2VydmVycyB3aG9zZVxuICAgICAgLy8gaW5ib3VuZCBwdXNoIG5vdGlmaWNhdGlvbnMgc2hvdWxkIHJlZ2lzdGVyIHRoaXMgc2Vzc2lvbi4gVGhlIG9wdGlvblxuICAgICAgLy8gaXMgYWRkZWQgaW5zaWRlIGEgZmVhdHVyZSgpIGJsb2NrIHNvIFRTIGRvZXNuJ3Qga25vdyBhYm91dCBpdFxuICAgICAgLy8gb24gdGhlIG9wdGlvbnMgdHlwZSBcdTIwMTQgc2FtZSBwYXR0ZXJuIGFzIC0tYXNzaXN0YW50IGF0IG1haW4udHN4OjE4MjQuXG4gICAgICAvLyBkZXZDaGFubmVscyBpcyBkZWZlcnJlZDogc2hvd1NldHVwU2NyZWVucyBzaG93cyBhIGNvbmZpcm1hdGlvbiBkaWFsb2dcbiAgICAgIC8vIGFuZCBvbmx5IGFwcGVuZHMgdG8gYWxsb3dlZENoYW5uZWxzIG9uIGFjY2VwdC5cbiAgICAgIGxldCBkZXZDaGFubmVsczogQ2hhbm5lbEVudHJ5W10gfCB1bmRlZmluZWRcbiAgICAgIGlmIChmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQ0hBTk5FTFMnKSkge1xuICAgICAgICAvLyBQYXJzZSBwbHVnaW46bmFtZUBtYXJrZXRwbGFjZSAvIHNlcnZlcjpZIHRhZ3MgaW50byB0eXBlZCBlbnRyaWVzLlxuICAgICAgICAvLyBUYWcgZGVjaWRlcyB0cnVzdCBtb2RlbCBkb3duc3RyZWFtOiBwbHVnaW4ta2luZCBoaXRzIG1hcmtldHBsYWNlXG4gICAgICAgIC8vIHZlcmlmaWNhdGlvbiArIEdyb3d0aEJvb2sgYWxsb3dsaXN0LCBzZXJ2ZXIta2luZCBhbHdheXMgZmFpbHNcbiAgICAgICAgLy8gYWxsb3dsaXN0IChzY2hlbWEgaXMgcGx1Z2luLW9ubHkpIHVubGVzcyBkZXYgZmxhZyBpcyBzZXQuXG4gICAgICAgIC8vIFVudGFnZ2VkIG9yIG1hcmtldHBsYWNlLWxlc3MgcGx1Z2luIGVudHJpZXMgYXJlIGhhcmQgZXJyb3JzIFx1MjAxNFxuICAgICAgICAvLyBzaWxlbnRseSBub3QtbWF0Y2hpbmcgaW4gdGhlIGdhdGUgd291bGQgbG9vayBsaWtlIGNoYW5uZWxzIGFyZVxuICAgICAgICAvLyBcIm9uXCIgYnV0IG5vdGhpbmcgZXZlciBmaXJlcy5cbiAgICAgICAgY29uc3QgcGFyc2VDaGFubmVsRW50cmllcyA9IChcbiAgICAgICAgICByYXc6IHN0cmluZ1tdLFxuICAgICAgICAgIGZsYWc6IHN0cmluZyxcbiAgICAgICAgKTogQ2hhbm5lbEVudHJ5W10gPT4ge1xuICAgICAgICAgIGNvbnN0IGVudHJpZXM6IENoYW5uZWxFbnRyeVtdID0gW11cbiAgICAgICAgICBjb25zdCBiYWQ6IHN0cmluZ1tdID0gW11cbiAgICAgICAgICBmb3IgKGNvbnN0IGMgb2YgcmF3KSB7XG4gICAgICAgICAgICBpZiAoYy5zdGFydHNXaXRoKCdwbHVnaW46JykpIHtcbiAgICAgICAgICAgICAgY29uc3QgcmVzdCA9IGMuc2xpY2UoNylcbiAgICAgICAgICAgICAgY29uc3QgYXQgPSByZXN0LmluZGV4T2YoJ0AnKVxuICAgICAgICAgICAgICBpZiAoYXQgPD0gMCB8fCBhdCA9PT0gcmVzdC5sZW5ndGggLSAxKSB7XG4gICAgICAgICAgICAgICAgYmFkLnB1c2goYylcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBlbnRyaWVzLnB1c2goe1xuICAgICAgICAgICAgICAgICAga2luZDogJ3BsdWdpbicsXG4gICAgICAgICAgICAgICAgICBuYW1lOiByZXN0LnNsaWNlKDAsIGF0KSxcbiAgICAgICAgICAgICAgICAgIG1hcmtldHBsYWNlOiByZXN0LnNsaWNlKGF0ICsgMSksXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChjLnN0YXJ0c1dpdGgoJ3NlcnZlcjonKSAmJiBjLmxlbmd0aCA+IDcpIHtcbiAgICAgICAgICAgICAgZW50cmllcy5wdXNoKHsga2luZDogJ3NlcnZlcicsIG5hbWU6IGMuc2xpY2UoNykgfSlcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGJhZC5wdXNoKGMpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIGlmIChiYWQubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICBgJHtmbGFnfSBlbnRyaWVzIG11c3QgYmUgdGFnZ2VkOiAke2JhZC5qb2luKCcsICcpfVxcbmAgK1xuICAgICAgICAgICAgICAgICAgYCAgcGx1Z2luOjxuYW1lPkA8bWFya2V0cGxhY2U+ICBcdTIwMTQgcGx1Z2luLXByb3ZpZGVkIGNoYW5uZWwgKGFsbG93bGlzdCBlbmZvcmNlZClcXG5gICtcbiAgICAgICAgICAgICAgICAgIGAgIHNlcnZlcjo8bmFtZT4gICAgICAgICAgICAgICAgXHUyMDE0IG1hbnVhbGx5IGNvbmZpZ3VyZWQgTUNQIHNlcnZlclxcbmAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG4gICAgICAgICAgcmV0dXJuIGVudHJpZXNcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGNoYW5uZWxPcHRzID0gb3B0aW9ucyBhcyB7XG4gICAgICAgICAgY2hhbm5lbHM/OiBzdHJpbmdbXVxuICAgICAgICAgIGRhbmdlcm91c2x5TG9hZERldmVsb3BtZW50Q2hhbm5lbHM/OiBzdHJpbmdbXVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IHJhd0NoYW5uZWxzID0gY2hhbm5lbE9wdHMuY2hhbm5lbHNcbiAgICAgICAgY29uc3QgcmF3RGV2ID0gY2hhbm5lbE9wdHMuZGFuZ2Vyb3VzbHlMb2FkRGV2ZWxvcG1lbnRDaGFubmVsc1xuICAgICAgICAvLyBBbHdheXMgcGFyc2UgKyBzZXQuIENoYW5uZWxzTm90aWNlIHJlYWRzIGdldEFsbG93ZWRDaGFubmVscygpIGFuZFxuICAgICAgICAvLyByZW5kZXJzIHRoZSBhcHByb3ByaWF0ZSBicmFuY2ggKGRpc2FibGVkL25vQXV0aC9wb2xpY3lCbG9ja2VkL1xuICAgICAgICAvLyBsaXN0ZW5pbmcpIGluIHRoZSBzdGFydHVwIHNjcmVlbi4gZ2F0ZUNoYW5uZWxTZXJ2ZXIoKSBlbmZvcmNlcy5cbiAgICAgICAgLy8gLS1jaGFubmVscyB3b3JrcyBpbiBib3RoIGludGVyYWN0aXZlIGFuZCBwcmludC9TREsgbW9kZXM7IGRldi1jaGFubmVsc1xuICAgICAgICAvLyBzdGF5cyBpbnRlcmFjdGl2ZS1vbmx5IChyZXF1aXJlcyBhIGNvbmZpcm1hdGlvbiBkaWFsb2cpLlxuICAgICAgICBsZXQgY2hhbm5lbEVudHJpZXM6IENoYW5uZWxFbnRyeVtdID0gW11cbiAgICAgICAgaWYgKHJhd0NoYW5uZWxzICYmIHJhd0NoYW5uZWxzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBjaGFubmVsRW50cmllcyA9IHBhcnNlQ2hhbm5lbEVudHJpZXMocmF3Q2hhbm5lbHMsICctLWNoYW5uZWxzJylcbiAgICAgICAgICBzZXRBbGxvd2VkQ2hhbm5lbHMoY2hhbm5lbEVudHJpZXMpXG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICAgIGlmIChyYXdEZXYgJiYgcmF3RGV2Lmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGRldkNoYW5uZWxzID0gcGFyc2VDaGFubmVsRW50cmllcyhcbiAgICAgICAgICAgICAgcmF3RGV2LFxuICAgICAgICAgICAgICAnLS1kYW5nZXJvdXNseS1sb2FkLWRldmVsb3BtZW50LWNoYW5uZWxzJyxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gRmxhZy11c2FnZSB0ZWxlbWV0cnkuIFBsdWdpbiBpZGVudGlmaWVycyBhcmUgbG9nZ2VkIChzYW1lIHRpZXIgYXNcbiAgICAgICAgLy8gdGVuZ3VfcGx1Z2luX2luc3RhbGxlZCBcdTIwMTQgcHVibGljLXJlZ2lzdHJ5LXN0eWxlIG5hbWVzKTsgc2VydmVyLWtpbmRcbiAgICAgICAgLy8gbmFtZXMgYXJlIG5vdCAoTUNQLXNlcnZlci1uYW1lIHRpZXIsIG9wdC1pbi1vbmx5IGVsc2V3aGVyZSkuXG4gICAgICAgIC8vIFBlci1zZXJ2ZXIgZ2F0ZSBvdXRjb21lcyBsYW5kIGluIHRlbmd1X21jcF9jaGFubmVsX2dhdGUgb25jZVxuICAgICAgICAvLyBzZXJ2ZXJzIGNvbm5lY3QuIERldiBlbnRyaWVzIGdvIHRocm91Z2ggYSBjb25maXJtYXRpb24gZGlhbG9nIGFmdGVyXG4gICAgICAgIC8vIHRoaXMgXHUyMDE0IGRldl9wbHVnaW5zIGNhcHR1cmVzIHdoYXQgd2FzIHR5cGVkLCBub3Qgd2hhdCB3YXMgYWNjZXB0ZWQuXG4gICAgICAgIGlmIChjaGFubmVsRW50cmllcy5sZW5ndGggPiAwIHx8IChkZXZDaGFubmVscz8ubGVuZ3RoID8/IDApID4gMCkge1xuICAgICAgICAgIGNvbnN0IGpvaW5QbHVnaW5JZHMgPSAoZW50cmllczogQ2hhbm5lbEVudHJ5W10pID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGlkcyA9IGVudHJpZXMuZmxhdE1hcChlID0+XG4gICAgICAgICAgICAgIGUua2luZCA9PT0gJ3BsdWdpbicgPyBbYCR7ZS5uYW1lfUAke2UubWFya2V0cGxhY2V9YF0gOiBbXSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIHJldHVybiBpZHMubGVuZ3RoID4gMFxuICAgICAgICAgICAgICA/IChpZHNcbiAgICAgICAgICAgICAgICAgIC5zb3J0KClcbiAgICAgICAgICAgICAgICAgIC5qb2luKFxuICAgICAgICAgICAgICAgICAgICAnLCcsXG4gICAgICAgICAgICAgICAgICApIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMpXG4gICAgICAgICAgICAgIDogdW5kZWZpbmVkXG4gICAgICAgICAgfVxuICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9tY3BfY2hhbm5lbF9mbGFncycsIHtcbiAgICAgICAgICAgIGNoYW5uZWxzX2NvdW50OiBjaGFubmVsRW50cmllcy5sZW5ndGgsXG4gICAgICAgICAgICBkZXZfY291bnQ6IGRldkNoYW5uZWxzPy5sZW5ndGggPz8gMCxcbiAgICAgICAgICAgIHBsdWdpbnM6IGpvaW5QbHVnaW5JZHMoY2hhbm5lbEVudHJpZXMpLFxuICAgICAgICAgICAgZGV2X3BsdWdpbnM6IGpvaW5QbHVnaW5JZHMoZGV2Q2hhbm5lbHMgPz8gW10pLFxuICAgICAgICAgIH0pXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU0RLIG9wdC1pbiBmb3IgU2VuZFVzZXJNZXNzYWdlIHZpYSAtLXRvb2xzLiBBbGwgc2Vzc2lvbnMgcmVxdWlyZVxuICAgICAgLy8gZXhwbGljaXQgb3B0LWluOyBsaXN0aW5nIGl0IGluIC0tdG9vbHMgc2lnbmFscyBpbnRlbnQuIFJ1bnMgQkVGT1JFXG4gICAgICAvLyBpbml0aWFsaXplVG9vbFBlcm1pc3Npb25Db250ZXh0IHNvIGdldFRvb2xzRm9yRGVmYXVsdFByZXNldCgpIHNlZXNcbiAgICAgIC8vIHRoZSB0b29sIGFzIGVuYWJsZWQgd2hlbiBjb21wdXRpbmcgdGhlIGJhc2UtdG9vbHMgZGlzYWxsb3cgZmlsdGVyLlxuICAgICAgLy8gQ29uZGl0aW9uYWwgcmVxdWlyZSBhdm9pZHMgbGVha2luZyB0aGUgdG9vbC1uYW1lIHN0cmluZyBpbnRvXG4gICAgICAvLyBleHRlcm5hbCBidWlsZHMuXG4gICAgICBpZiAoXG4gICAgICAgIChmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKSkgJiZcbiAgICAgICAgYmFzZVRvb2xzLmxlbmd0aCA+IDBcbiAgICAgICkge1xuICAgICAgICAvKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4gICAgICAgIGNvbnN0IHsgQlJJRUZfVE9PTF9OQU1FLCBMRUdBQ1lfQlJJRUZfVE9PTF9OQU1FIH0gPVxuICAgICAgICAgIHJlcXVpcmUoJy4vdG9vbHMvQnJpZWZUb29sL3Byb21wdC5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdG9vbHMvQnJpZWZUb29sL3Byb21wdC5qcycpXG4gICAgICAgIGNvbnN0IHsgaXNCcmllZkVudGl0bGVkIH0gPVxuICAgICAgICAgIHJlcXVpcmUoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpXG4gICAgICAgIC8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVRvb2xMaXN0RnJvbUNMSShiYXNlVG9vbHMpXG4gICAgICAgIGlmIChcbiAgICAgICAgICAocGFyc2VkLmluY2x1ZGVzKEJSSUVGX1RPT0xfTkFNRSkgfHxcbiAgICAgICAgICAgIHBhcnNlZC5pbmNsdWRlcyhMRUdBQ1lfQlJJRUZfVE9PTF9OQU1FKSkgJiZcbiAgICAgICAgICBpc0JyaWVmRW50aXRsZWQoKVxuICAgICAgICApIHtcbiAgICAgICAgICBzZXRVc2VyTXNnT3B0SW4odHJ1ZSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBUaGlzIGF3YWl0IHJlcGxhY2VzIGJsb2NraW5nIGV4aXN0c1N5bmMvc3RhdFN5bmMgY2FsbHMgdGhhdCB3ZXJlIGFscmVhZHkgaW5cbiAgICAgIC8vIHRoZSBzdGFydHVwIHBhdGguIFdhbGwtY2xvY2sgdGltZSBpcyB1bmNoYW5nZWQ7IHdlIGp1c3QgeWllbGQgdG8gdGhlIGV2ZW50XG4gICAgICAvLyBsb29wIGR1cmluZyB0aGUgZnMgSS9PIGluc3RlYWQgb2YgYmxvY2tpbmcgaXQuIFNlZSAjMTk2NjEuXG4gICAgICBjb25zdCBpbml0UmVzdWx0ID0gYXdhaXQgaW5pdGlhbGl6ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCh7XG4gICAgICAgIGFsbG93ZWRUb29sc0NsaTogYWxsb3dlZFRvb2xzLFxuICAgICAgICBkaXNhbGxvd2VkVG9vbHNDbGk6IGRpc2FsbG93ZWRUb29scyxcbiAgICAgICAgYmFzZVRvb2xzQ2xpOiBiYXNlVG9vbHMsXG4gICAgICAgIHBlcm1pc3Npb25Nb2RlLFxuICAgICAgICBhbGxvd0Rhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICBhZGREaXJzOiBhZGREaXIsXG4gICAgICB9KVxuICAgICAgbGV0IHRvb2xQZXJtaXNzaW9uQ29udGV4dCA9IGluaXRSZXN1bHQudG9vbFBlcm1pc3Npb25Db250ZXh0XG4gICAgICBjb25zdCB7IHdhcm5pbmdzLCBkYW5nZXJvdXNQZXJtaXNzaW9ucywgb3Zlcmx5QnJvYWRCYXNoUGVybWlzc2lvbnMgfSA9XG4gICAgICAgIGluaXRSZXN1bHRcblxuICAgICAgLy8gSGFuZGxlIG92ZXJseSBicm9hZCBzaGVsbCBhbGxvdyBydWxlcyBmb3IgYW50IHVzZXJzIChCYXNoKCopLCBQb3dlclNoZWxsKCopKVxuICAgICAgaWYgKFxuICAgICAgICBcImV4dGVybmFsXCIgPT09ICdhbnQnICYmXG4gICAgICAgIG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLmxlbmd0aCA+IDBcbiAgICAgICkge1xuICAgICAgICBmb3IgKGNvbnN0IHBlcm1pc3Npb24gb2Ygb3Zlcmx5QnJvYWRCYXNoUGVybWlzc2lvbnMpIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgSWdub3Jpbmcgb3Zlcmx5IGJyb2FkIHNoZWxsIHBlcm1pc3Npb24gJHtwZXJtaXNzaW9uLnJ1bGVEaXNwbGF5fSBmcm9tICR7cGVybWlzc2lvbi5zb3VyY2VEaXNwbGF5fWAsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICAgIHRvb2xQZXJtaXNzaW9uQ29udGV4dCA9IHJlbW92ZURhbmdlcm91c1Blcm1pc3Npb25zKFxuICAgICAgICAgIHRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgICBvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucyxcbiAgICAgICAgKVxuICAgICAgfVxuXG4gICAgICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykgJiYgZGFuZ2Vyb3VzUGVybWlzc2lvbnMubGVuZ3RoID4gMCkge1xuICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQgPSBzdHJpcERhbmdlcm91c1Blcm1pc3Npb25zRm9yQXV0b01vZGUoXG4gICAgICAgICAgdG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIC8vIFByaW50IGFueSB3YXJuaW5ncyBmcm9tIGluaXRpYWxpemF0aW9uXG4gICAgICB3YXJuaW5ncy5mb3JFYWNoKHdhcm5pbmcgPT4ge1xuICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgIGNvbnNvbGUuZXJyb3Iod2FybmluZylcbiAgICAgIH0pXG5cbiAgICAgIHZvaWQgYXNzZXJ0TWluVmVyc2lvbigpXG5cbiAgICAgIC8vIGNsYXVkZS5haSBjb25maWcgZmV0Y2g6IC1wIG1vZGUgb25seSAoaW50ZXJhY3RpdmUgdXNlcyB1c2VNYW5hZ2VNQ1BDb25uZWN0aW9uc1xuICAgICAgLy8gdHdvLXBoYXNlIGxvYWRpbmcpLiBLaWNrZWQgb2ZmIGhlcmUgdG8gb3ZlcmxhcCB3aXRoIHNldHVwKCk7IGF3YWl0ZWRcbiAgICAgIC8vIGJlZm9yZSBydW5IZWFkbGVzcyBzbyBzaW5nbGUtdHVybiAtcCBzZWVzIGNvbm5lY3RvcnMuIFNraXBwZWQgdW5kZXJcbiAgICAgIC8vIGVudGVycHJpc2Uvc3RyaWN0IE1DUCB0byBwcmVzZXJ2ZSBwb2xpY3kgYm91bmRhcmllcy5cbiAgICAgIGNvbnN0IGNsYXVkZWFpQ29uZmlnUHJvbWlzZTogUHJvbWlzZTxcbiAgICAgICAgUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPlxuICAgICAgPiA9XG4gICAgICAgIGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uICYmXG4gICAgICAgICFzdHJpY3RNY3BDb25maWcgJiZcbiAgICAgICAgIWRvZXNFbnRlcnByaXNlTWNwQ29uZmlnRXhpc3QoKSAmJlxuICAgICAgICAvLyAtLWJhcmUgLyBTSU1QTEU6IHNraXAgY2xhdWRlLmFpIHByb3h5IHNlcnZlcnMgKGRhdGFkb2csIEdtYWlsLFxuICAgICAgICAvLyBTbGFjaywgQmlnUXVlcnksIFB1Yk1lZCBcdTIwMTQgNi0xNHMgZWFjaCB0byBjb25uZWN0KS4gU2NyaXB0ZWQgY2FsbHNcbiAgICAgICAgLy8gdGhhdCBuZWVkIE1DUCBwYXNzIC0tbWNwLWNvbmZpZyBleHBsaWNpdGx5LlxuICAgICAgICAhaXNCYXJlTW9kZSgpXG4gICAgICAgICAgPyBmZXRjaENsYXVkZUFJTWNwQ29uZmlnc0lmRWxpZ2libGUoKS50aGVuKGNvbmZpZ3MgPT4ge1xuICAgICAgICAgICAgICBjb25zdCB7IGFsbG93ZWQsIGJsb2NrZWQgfSA9IGZpbHRlck1jcFNlcnZlcnNCeVBvbGljeShjb25maWdzKVxuICAgICAgICAgICAgICBpZiAoYmxvY2tlZC5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgICBgV2FybmluZzogY2xhdWRlLmFpIE1DUCAke3BsdXJhbChibG9ja2VkLmxlbmd0aCwgJ3NlcnZlcicpfSBibG9ja2VkIGJ5IGVudGVycHJpc2UgcG9saWN5OiAke2Jsb2NrZWQuam9pbignLCAnKX1cXG5gLFxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICByZXR1cm4gYWxsb3dlZFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICA6IFByb21pc2UucmVzb2x2ZSh7fSlcblxuICAgICAgLy8gS2ljayBvZmYgTUNQIGNvbmZpZyBsb2FkaW5nIGVhcmx5IChzYWZlIC0ganVzdCByZWFkcyBmaWxlcywgbm8gZXhlY3V0aW9uKS5cbiAgICAgIC8vIEJvdGggaW50ZXJhY3RpdmUgYW5kIC1wIHVzZSBnZXRDbGF1ZGVDb2RlTWNwQ29uZmlncyAobG9jYWwgZmlsZSByZWFkcyBvbmx5KS5cbiAgICAgIC8vIFRoZSBsb2NhbCBwcm9taXNlIGlzIGF3YWl0ZWQgbGF0ZXIgKGJlZm9yZSBwcmVmZXRjaEFsbE1jcFJlc291cmNlcykgdG9cbiAgICAgIC8vIG92ZXJsYXAgY29uZmlnIEkvTyB3aXRoIHNldHVwKCksIGNvbW1hbmRzIGxvYWRpbmcsIGFuZCB0cnVzdCBkaWFsb2cuXG4gICAgICBsb2dGb3JEZWJ1Z2dpbmcoJ1tTVEFSVFVQXSBMb2FkaW5nIE1DUCBjb25maWdzLi4uJylcbiAgICAgIGNvbnN0IG1jcENvbmZpZ1N0YXJ0ID0gRGF0ZS5ub3coKVxuICAgICAgbGV0IG1jcENvbmZpZ1Jlc29sdmVkTXM6IG51bWJlciB8IHVuZGVmaW5lZFxuICAgICAgLy8gLS1iYXJlIHNraXBzIGF1dG8tZGlzY292ZXJlZCBNQ1AgKC5tY3AuanNvbiwgdXNlciBzZXR0aW5ncywgcGx1Z2lucykgXHUyMDE0XG4gICAgICAvLyBvbmx5IGV4cGxpY2l0IC0tbWNwLWNvbmZpZyB3b3Jrcy4gZHluYW1pY01jcENvbmZpZyBpcyBzcHJlYWQgb250b1xuICAgICAgLy8gYWxsTWNwQ29uZmlncyBkb3duc3RyZWFtIHNvIGl0IHN1cnZpdmVzIHRoaXMgc2tpcC5cbiAgICAgIGNvbnN0IG1jcENvbmZpZ1Byb21pc2UgPSAoXG4gICAgICAgIHN0cmljdE1jcENvbmZpZyB8fCBpc0JhcmVNb2RlKClcbiAgICAgICAgICA/IFByb21pc2UucmVzb2x2ZSh7XG4gICAgICAgICAgICAgIHNlcnZlcnM6IHt9IGFzIFJlY29yZDxzdHJpbmcsIFNjb3BlZE1jcFNlcnZlckNvbmZpZz4sXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIDogZ2V0Q2xhdWRlQ29kZU1jcENvbmZpZ3MoZHluYW1pY01jcENvbmZpZylcbiAgICAgICkudGhlbihyZXN1bHQgPT4ge1xuICAgICAgICBtY3BDb25maWdSZXNvbHZlZE1zID0gRGF0ZS5ub3coKSAtIG1jcENvbmZpZ1N0YXJ0XG4gICAgICAgIHJldHVybiByZXN1bHRcbiAgICAgIH0pXG5cbiAgICAgIC8vIE5PVEU6IFdlIGRvIE5PVCBjYWxsIHByZWZldGNoQWxsTWNwUmVzb3VyY2VzIGhlcmUgLSB0aGF0J3MgZGVmZXJyZWQgdW50aWwgYWZ0ZXIgdHJ1c3QgZGlhbG9nXG5cbiAgICAgIGlmIChcbiAgICAgICAgaW5wdXRGb3JtYXQgJiZcbiAgICAgICAgaW5wdXRGb3JtYXQgIT09ICd0ZXh0JyAmJlxuICAgICAgICBpbnB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJ1xuICAgICAgKSB7XG4gICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOjogaW50ZW50aW9uYWwgY29uc29sZSBvdXRwdXRcbiAgICAgICAgY29uc29sZS5lcnJvcihgRXJyb3I6IEludmFsaWQgaW5wdXQgZm9ybWF0IFwiJHtpbnB1dEZvcm1hdH1cIi5gKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH1cbiAgICAgIGlmIChpbnB1dEZvcm1hdCA9PT0gJ3N0cmVhbS1qc29uJyAmJiBvdXRwdXRGb3JtYXQgIT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgICAgLy8gYmlvbWUtaWdub3JlIGxpbnQvc3VzcGljaW91cy9ub0NvbnNvbGU6OiBpbnRlbnRpb25hbCBjb25zb2xlIG91dHB1dFxuICAgICAgICBjb25zb2xlLmVycm9yKFxuICAgICAgICAgIGBFcnJvcjogLS1pbnB1dC1mb3JtYXQ9c3RyZWFtLWpzb24gcmVxdWlyZXMgb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbi5gLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSBzZGtVcmwgaXMgb25seSB1c2VkIHdpdGggYXBwcm9wcmlhdGUgZm9ybWF0cyAoZm9ybWF0cyBhcmUgYXV0by1zZXQgYWJvdmUpXG4gICAgICBpZiAoc2RrVXJsKSB7XG4gICAgICAgIGlmIChpbnB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJyB8fCBvdXRwdXRGb3JtYXQgIT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIGBFcnJvcjogLS1zZGstdXJsIHJlcXVpcmVzIGJvdGggLS1pbnB1dC1mb3JtYXQ9c3RyZWFtLWpzb24gYW5kIC0tb3V0cHV0LWZvcm1hdD1zdHJlYW0tanNvbi5gLFxuICAgICAgICAgIClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBWYWxpZGF0ZSByZXBsYXlVc2VyTWVzc2FnZXMgaXMgb25seSB1c2VkIHdpdGggc3RyZWFtLWpzb24gZm9ybWF0c1xuICAgICAgaWYgKG9wdGlvbnMucmVwbGF5VXNlck1lc3NhZ2VzKSB7XG4gICAgICAgIGlmIChpbnB1dEZvcm1hdCAhPT0gJ3N0cmVhbS1qc29uJyB8fCBvdXRwdXRGb3JtYXQgIT09ICdzdHJlYW0tanNvbicpIHtcbiAgICAgICAgICAvLyBiaW9tZS1pZ25vcmUgbGludC9zdXNwaWNpb3VzL25vQ29uc29sZTo6IGludGVudGlvbmFsIGNvbnNvbGUgb3V0cHV0XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcbiAgICAgICAgICAgIGBFcnJvcjogLS1yZXBsYXktdXNlci1tZXNzYWdlcyByZXF1aXJlcyBib3RoIC0taW5wdXQtZm9ybWF0PXN0cmVhbS1qc29uIGFuZCAtLW91dHB1dC1mb3JtYXQ9c3RyZWFtLWpzb24uYCxcbiAgICAgICAgICApXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gVmFsaWRhdGUgaW5jbHVkZVBhcnRpYWxNZXNzYWdlcyBpcyBvbmx5IHVzZWQgd2l0aCBwcmludCBtb2RlIGFuZCBzdHJlYW0tanNvbiBvdXRwdXRcbiAgICAgIGlmIChlZmZlY3RpdmVJbmNsdWRlUGFydGlhbE1lc3NhZ2VzKSB7XG4gICAgICAgIGlmICghaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gfHwgb3V0cHV0Rm9ybWF0ICE9PSAnc3RyZWFtLWpzb24nKSB7XG4gICAgICAgICAgd3JpdGVUb1N0ZGVycihcbiAgICAgICAgICAgIGBFcnJvcjogLS1pbmNsdWRlLXBhcnRpYWwtbWVzc2FnZXMgcmVxdWlyZXMgLS1wcmludCBhbmQgLS1vdXRwdXQtZm9ybWF0PXN0cmVhbS1qc29uLmAsXG4gICAgICAgICAgKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFZhbGlkYXRlIC0tbm8tc2Vzc2lvbi1wZXJzaXN0ZW5jZSBpcyBvbmx5IHVzZWQgd2l0aCBwcmludCBtb2RlXG4gICAgICBpZiAob3B0aW9ucy5zZXNzaW9uUGVyc2lzdGVuY2UgPT09IGZhbHNlICYmICFpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICB3cml0ZVRvU3RkZXJyKFxuICAgICAgICAgIGBFcnJvcjogLS1uby1zZXNzaW9uLXBlcnNpc3RlbmNlIGNhbiBvbmx5IGJlIHVzZWQgd2l0aCAtLXByaW50IG1vZGUuYCxcbiAgICAgICAgKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH1cblxuICAgICAgY29uc3QgZWZmZWN0aXZlUHJvbXB0ID0gcHJvbXB0IHx8ICcnXG4gICAgICBsZXQgaW5wdXRQcm9tcHQgPSBhd2FpdCBnZXRJbnB1dFByb21wdChcbiAgICAgICAgZWZmZWN0aXZlUHJvbXB0LFxuICAgICAgICAoaW5wdXRGb3JtYXQgPz8gJ3RleHQnKSBhcyAndGV4dCcgfCAnc3RyZWFtLWpzb24nLFxuICAgICAgKVxuICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl9hZnRlcl9pbnB1dF9wcm9tcHQnKVxuXG4gICAgICAvLyBBY3RpdmF0ZSBwcm9hY3RpdmUgbW9kZSBCRUZPUkUgZ2V0VG9vbHMoKSBzbyBTbGVlcFRvb2wuaXNFbmFibGVkKClcbiAgICAgIC8vICh3aGljaCByZXR1cm5zIGlzUHJvYWN0aXZlQWN0aXZlKCkpIHBhc3NlcyBhbmQgU2xlZXAgaXMgaW5jbHVkZWQuXG4gICAgICAvLyBUaGUgbGF0ZXIgUkVQTC1wYXRoIG1heWJlQWN0aXZhdGVQcm9hY3RpdmUoKSBjYWxscyBhcmUgaWRlbXBvdGVudC5cbiAgICAgIG1heWJlQWN0aXZhdGVQcm9hY3RpdmUob3B0aW9ucylcblxuICAgICAgbGV0IHRvb2xzID0gZ2V0VG9vbHModG9vbFBlcm1pc3Npb25Db250ZXh0KVxuXG4gICAgICAvLyBBcHBseSBjb29yZGluYXRvciBtb2RlIHRvb2wgZmlsdGVyaW5nIGZvciBoZWFkbGVzcyBwYXRoXG4gICAgICAvLyAobWlycm9ycyB1c2VNZXJnZWRUb29scy50cyBmaWx0ZXJpbmcgZm9yIFJFUEwvaW50ZXJhY3RpdmUgcGF0aClcbiAgICAgIGlmIChcbiAgICAgICAgZmVhdHVyZSgnQ09PUkRJTkFUT1JfTU9ERScpICYmXG4gICAgICAgIGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0NPT1JESU5BVE9SX01PREUpXG4gICAgICApIHtcbiAgICAgICAgY29uc3QgeyBhcHBseUNvb3JkaW5hdG9yVG9vbEZpbHRlciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICcuL3V0aWxzL3Rvb2xQb29sLmpzJ1xuICAgICAgICApXG4gICAgICAgIHRvb2xzID0gYXBwbHlDb29yZGluYXRvclRvb2xGaWx0ZXIodG9vbHMpXG4gICAgICB9XG5cbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25fdG9vbHNfbG9hZGVkJylcblxuICAgICAgbGV0IGpzb25TY2hlbWE6IFRvb2xJbnB1dEpTT05TY2hlbWEgfCB1bmRlZmluZWRcbiAgICAgIGlmIChcbiAgICAgICAgaXNTeW50aGV0aWNPdXRwdXRUb29sRW5hYmxlZCh7IGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uIH0pICYmXG4gICAgICAgIG9wdGlvbnMuanNvblNjaGVtYVxuICAgICAgKSB7XG4gICAgICAgIGpzb25TY2hlbWEgPSBqc29uUGFyc2Uob3B0aW9ucy5qc29uU2NoZW1hKSBhcyBUb29sSW5wdXRKU09OU2NoZW1hXG4gICAgICB9XG5cbiAgICAgIGlmIChqc29uU2NoZW1hKSB7XG4gICAgICAgIGNvbnN0IHN5bnRoZXRpY091dHB1dFJlc3VsdCA9IGNyZWF0ZVN5bnRoZXRpY091dHB1dFRvb2woanNvblNjaGVtYSlcbiAgICAgICAgaWYgKCd0b29sJyBpbiBzeW50aGV0aWNPdXRwdXRSZXN1bHQpIHtcbiAgICAgICAgICAvLyBBZGQgU3ludGhldGljT3V0cHV0VG9vbCB0byB0aGUgdG9vbHMgYXJyYXkgQUZURVIgZ2V0VG9vbHMoKSBmaWx0ZXJpbmcuXG4gICAgICAgICAgLy8gVGhpcyB0b29sIGlzIGV4Y2x1ZGVkIGZyb20gbm9ybWFsIGZpbHRlcmluZyAoc2VlIHRvb2xzLnRzKSBiZWNhdXNlIGl0J3NcbiAgICAgICAgICAvLyBhbiBpbXBsZW1lbnRhdGlvbiBkZXRhaWwgZm9yIHN0cnVjdHVyZWQgb3V0cHV0LCBub3QgYSB1c2VyLWNvbnRyb2xsZWQgdG9vbC5cbiAgICAgICAgICB0b29scyA9IFsuLi50b29scywgc3ludGhldGljT3V0cHV0UmVzdWx0LnRvb2xdXG5cbiAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc3RydWN0dXJlZF9vdXRwdXRfZW5hYmxlZCcsIHtcbiAgICAgICAgICAgIHNjaGVtYV9wcm9wZXJ0eV9jb3VudDogT2JqZWN0LmtleXMoXG4gICAgICAgICAgICAgIChqc29uU2NoZW1hLnByb3BlcnRpZXMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pIHx8IHt9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAubGVuZ3RoIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICBoYXNfcmVxdWlyZWRfZmllbGRzOiBCb29sZWFuKFxuICAgICAgICAgICAgICBqc29uU2NoZW1hLnJlcXVpcmVkLFxuICAgICAgICAgICAgKSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgIH0pXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3N0cnVjdHVyZWRfb3V0cHV0X2ZhaWx1cmUnLCB7XG4gICAgICAgICAgICBlcnJvcjpcbiAgICAgICAgICAgICAgJ0ludmFsaWQgSlNPTiBzY2hlbWEnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBJTVBPUlRBTlQ6IHNldHVwKCkgbXVzdCBiZSBjYWxsZWQgYmVmb3JlIGFueSBvdGhlciBjb2RlIHRoYXQgZGVwZW5kcyBvbiB0aGUgY3dkIG9yIHdvcmt0cmVlIHNldHVwXG4gICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2JlZm9yZV9zZXR1cCcpXG4gICAgICBsb2dGb3JEZWJ1Z2dpbmcoJ1tTVEFSVFVQXSBSdW5uaW5nIHNldHVwKCkuLi4nKVxuICAgICAgY29uc3Qgc2V0dXBTdGFydCA9IERhdGUubm93KClcbiAgICAgIGNvbnN0IHsgc2V0dXAgfSA9IGF3YWl0IGltcG9ydCgnLi9zZXR1cC5qcycpXG4gICAgICBjb25zdCBtZXNzYWdpbmdTb2NrZXRQYXRoID0gZmVhdHVyZSgnVURTX0lOQk9YJylcbiAgICAgICAgPyAob3B0aW9ucyBhcyB7IG1lc3NhZ2luZ1NvY2tldFBhdGg/OiBzdHJpbmcgfSkubWVzc2FnaW5nU29ja2V0UGF0aFxuICAgICAgICA6IHVuZGVmaW5lZFxuICAgICAgLy8gUGFyYWxsZWxpemUgc2V0dXAoKSB3aXRoIGNvbW1hbmRzK2FnZW50cyBsb2FkaW5nLiBzZXR1cCgpJ3MgfjI4bXMgaXNcbiAgICAgIC8vIG1vc3RseSBzdGFydFVkc01lc3NhZ2luZyAoc29ja2V0IGJpbmQsIH4yMG1zKSBcdTIwMTQgbm90IGRpc2stYm91bmQsIHNvIGl0XG4gICAgICAvLyBkb2Vzbid0IGNvbnRlbmQgd2l0aCBnZXRDb21tYW5kcycgZmlsZSByZWFkcy4gR2F0ZWQgb24gIXdvcmt0cmVlRW5hYmxlZFxuICAgICAgLy8gc2luY2UgLS13b3JrdHJlZSBtYWtlcyBzZXR1cCgpIHByb2Nlc3MuY2hkaXIoKSAoc2V0dXAudHM6MjAzKSwgYW5kXG4gICAgICAvLyBjb21tYW5kcy9hZ2VudHMgbmVlZCB0aGUgcG9zdC1jaGRpciBjd2QuXG4gICAgICBjb25zdCBwcmVTZXR1cEN3ZCA9IGdldEN3ZCgpXG4gICAgICAvLyBSZWdpc3RlciBidW5kbGVkIHNraWxscy9wbHVnaW5zIGJlZm9yZSBraWNraW5nIGdldENvbW1hbmRzKCkgXHUyMDE0IHRoZXkncmVcbiAgICAgIC8vIHB1cmUgaW4tbWVtb3J5IGFycmF5IHB1c2hlcyAoPDFtcywgemVybyBJL08pIHRoYXQgZ2V0QnVuZGxlZFNraWxscygpXG4gICAgICAvLyByZWFkcyBzeW5jaHJvbm91c2x5LiBQcmV2aW91c2x5IHJhbiBpbnNpZGUgc2V0dXAoKSBhZnRlciB+MjBtcyBvZlxuICAgICAgLy8gYXdhaXQgcG9pbnRzLCBzbyB0aGUgcGFyYWxsZWwgZ2V0Q29tbWFuZHMoKSBtZW1vaXplZCBhbiBlbXB0eSBsaXN0LlxuICAgICAgaWYgKHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0VOVFJZUE9JTlQgIT09ICdsb2NhbC1hZ2VudCcpIHtcbiAgICAgICAgaW5pdEJ1aWx0aW5QbHVnaW5zKClcbiAgICAgICAgaW5pdEJ1bmRsZWRTa2lsbHMoKVxuICAgICAgfVxuICAgICAgY29uc3Qgc2V0dXBQcm9taXNlID0gc2V0dXAoXG4gICAgICAgIHByZVNldHVwQ3dkLFxuICAgICAgICBwZXJtaXNzaW9uTW9kZSxcbiAgICAgICAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcbiAgICAgICAgd29ya3RyZWVFbmFibGVkLFxuICAgICAgICB3b3JrdHJlZU5hbWUsXG4gICAgICAgIHRtdXhFbmFibGVkLFxuICAgICAgICBzZXNzaW9uSWQgPyB2YWxpZGF0ZVV1aWQoc2Vzc2lvbklkKSA6IHVuZGVmaW5lZCxcbiAgICAgICAgd29ya3RyZWVQUk51bWJlcixcbiAgICAgICAgbWVzc2FnaW5nU29ja2V0UGF0aCxcbiAgICAgIClcbiAgICAgIGNvbnN0IGNvbW1hbmRzUHJvbWlzZSA9IHdvcmt0cmVlRW5hYmxlZCA/IG51bGwgOiBnZXRDb21tYW5kcyhwcmVTZXR1cEN3ZClcbiAgICAgIGNvbnN0IGFnZW50RGVmc1Byb21pc2UgPSB3b3JrdHJlZUVuYWJsZWRcbiAgICAgICAgPyBudWxsXG4gICAgICAgIDogZ2V0QWdlbnREZWZpbml0aW9uc1dpdGhPdmVycmlkZXMocHJlU2V0dXBDd2QpXG4gICAgICAvLyBTdXBwcmVzcyB0cmFuc2llbnQgdW5oYW5kbGVkUmVqZWN0aW9uIGlmIHRoZXNlIHJlamVjdCBkdXJpbmcgdGhlXG4gICAgICAvLyB+MjhtcyBzZXR1cFByb21pc2UgYXdhaXQgYmVmb3JlIFByb21pc2UuYWxsIGpvaW5zIHRoZW0gYmVsb3cuXG4gICAgICBjb21tYW5kc1Byb21pc2U/LmNhdGNoKCgpID0+IHt9KVxuICAgICAgYWdlbnREZWZzUHJvbWlzZT8uY2F0Y2goKCkgPT4ge30pXG4gICAgICBhd2FpdCBzZXR1cFByb21pc2VcbiAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgYFtTVEFSVFVQXSBzZXR1cCgpIGNvbXBsZXRlZCBpbiAke0RhdGUubm93KCkgLSBzZXR1cFN0YXJ0fW1zYCxcbiAgICAgIClcbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25fYWZ0ZXJfc2V0dXAnKVxuXG4gICAgICAvLyBSZXBsYXkgdXNlciBtZXNzYWdlcyBpbnRvIHN0cmVhbS1qc29uIG9ubHkgd2hlbiB0aGUgc29ja2V0IHdhc1xuICAgICAgLy8gZXhwbGljaXRseSByZXF1ZXN0ZWQuIFRoZSBhdXRvLWdlbmVyYXRlZCBzb2NrZXQgaXMgcGFzc2l2ZSBcdTIwMTQgaXRcbiAgICAgIC8vIGxldHMgdG9vbHMgaW5qZWN0IGlmIHRoZXkgd2FudCB0bywgYnV0IHR1cm5pbmcgaXQgb24gYnkgZGVmYXVsdFxuICAgICAgLy8gc2hvdWxkbid0IHJlc2hhcGUgc3RyZWFtLWpzb24gZm9yIFNESyBjb25zdW1lcnMgd2hvIG5ldmVyIHRvdWNoIGl0LlxuICAgICAgLy8gQ2FsbGVycyB3aG8gaW5qZWN0IGFuZCBhbHNvIHdhbnQgdGhvc2UgaW5qZWN0aW9ucyB2aXNpYmxlIGluIHRoZVxuICAgICAgLy8gc3RyZWFtIHBhc3MgLS1tZXNzYWdpbmctc29ja2V0LXBhdGggZXhwbGljaXRseSAob3IgLS1yZXBsYXktdXNlci1tZXNzYWdlcykuXG4gICAgICBsZXQgZWZmZWN0aXZlUmVwbGF5VXNlck1lc3NhZ2VzID0gISFvcHRpb25zLnJlcGxheVVzZXJNZXNzYWdlc1xuICAgICAgaWYgKGZlYXR1cmUoJ1VEU19JTkJPWCcpKSB7XG4gICAgICAgIGlmICghZWZmZWN0aXZlUmVwbGF5VXNlck1lc3NhZ2VzICYmIG91dHB1dEZvcm1hdCA9PT0gJ3N0cmVhbS1qc29uJykge1xuICAgICAgICAgIGVmZmVjdGl2ZVJlcGxheVVzZXJNZXNzYWdlcyA9ICEhKFxuICAgICAgICAgICAgb3B0aW9ucyBhcyB7IG1lc3NhZ2luZ1NvY2tldFBhdGg/OiBzdHJpbmcgfVxuICAgICAgICAgICkubWVzc2FnaW5nU29ja2V0UGF0aFxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGlmIChnZXRJc05vbkludGVyYWN0aXZlU2Vzc2lvbigpKSB7XG4gICAgICAgIC8vIEFwcGx5IGZ1bGwgbWVyZ2VkIHNldHRpbmdzIGVudiBub3cgKGluY2x1ZGluZyBwcm9qZWN0LXNjb3BlZFxuICAgICAgICAvLyAuY2xhdWRlL3NldHRpbmdzLmpzb24gUEFUSC9HSVRfRElSL0dJVF9XT1JLX1RSRUUpIHNvIGdpdEV4ZSgpIGFuZFxuICAgICAgICAvLyB0aGUgZ2l0IHNwYXduIGJlbG93IHNlZSBpdC4gVHJ1c3QgaXMgaW1wbGljaXQgaW4gLXAgbW9kZTsgdGhlXG4gICAgICAgIC8vIGRvY3N0cmluZyBhdCBtYW5hZ2VkRW52LnRzOjk2LTk3IHNheXMgdGhpcyBhcHBsaWVzIFwicG90ZW50aWFsbHlcbiAgICAgICAgLy8gZGFuZ2Vyb3VzIGVudmlyb25tZW50IHZhcmlhYmxlcyBzdWNoIGFzIExEX1BSRUxPQUQsIFBBVEhcIiBmcm9tIGFsbFxuICAgICAgICAvLyBzb3VyY2VzLiBUaGUgbGF0ZXIgY2FsbCBpbiB0aGUgaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24gYmxvY2sgYmVsb3dcbiAgICAgICAgLy8gaXMgaWRlbXBvdGVudCAoT2JqZWN0LmFzc2lnbiwgY29uZmlndXJlR2xvYmFsQWdlbnRzIGVqZWN0cyBwcmlvclxuICAgICAgICAvLyBpbnRlcmNlcHRvcikgYW5kIHBpY2tzIHVwIGFueSBwbHVnaW4tY29udHJpYnV0ZWQgZW52IGFmdGVyIHBsdWdpblxuICAgICAgICAvLyBpbml0LiBQcm9qZWN0IHNldHRpbmdzIGFyZSBhbHJlYWR5IGxvYWRlZCBoZXJlOlxuICAgICAgICAvLyBhcHBseVNhZmVDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcyBpbiBpbml0KCkgY2FsbGVkXG4gICAgICAgIC8vIGdldFNldHRpbmdzX0RFUFJFQ0FURUQgYXQgbWFuYWdlZEVudi50czo4NiB3aGljaCBtZXJnZXMgYWxsIGVuYWJsZWRcbiAgICAgICAgLy8gc291cmNlcyBpbmNsdWRpbmcgcHJvamVjdFNldHRpbmdzL2xvY2FsU2V0dGluZ3MuXG4gICAgICAgIGFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMoKVxuXG4gICAgICAgIC8vIFNwYXduIGdpdCBzdGF0dXMvbG9nL2JyYW5jaCBub3cgc28gdGhlIHN1YnByb2Nlc3MgZXhlY3V0aW9uIG92ZXJsYXBzXG4gICAgICAgIC8vIHdpdGggdGhlIGdldENvbW1hbmRzIGF3YWl0IGJlbG93IGFuZCBzdGFydERlZmVycmVkUHJlZmV0Y2hlcy4gQWZ0ZXJcbiAgICAgICAgLy8gc2V0dXAoKSBzbyBjd2QgaXMgZmluYWwgKHNldHVwLnRzOjI1NCBtYXkgcHJvY2Vzcy5jaGRpcih3b3JrdHJlZVBhdGgpXG4gICAgICAgIC8vIGZvciAtLXdvcmt0cmVlKSBhbmQgYWZ0ZXIgdGhlIGFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMgYWJvdmVcbiAgICAgICAgLy8gc28gUEFUSC9HSVRfRElSL0dJVF9XT1JLX1RSRUUgZnJvbSBhbGwgc291cmNlcyAodHJ1c3RlZCArIHByb2plY3QpXG4gICAgICAgIC8vIGFyZSBhcHBsaWVkLiBnZXRTeXN0ZW1Db250ZXh0IGlzIG1lbW9pemVkOyB0aGVcbiAgICAgICAgLy8gcHJlZmV0Y2hTeXN0ZW1Db250ZXh0SWZTYWZlIGNhbGwgaW4gc3RhcnREZWZlcnJlZFByZWZldGNoZXMgYmVjb21lc1xuICAgICAgICAvLyBhIGNhY2hlIGhpdC4gVGhlIG1pY3JvdGFzayBmcm9tIGF3YWl0IGdldElzR2l0KCkgZHJhaW5zIGF0IHRoZVxuICAgICAgICAvLyBnZXRDb21tYW5kcyBQcm9taXNlLmFsbCBhd2FpdCBiZWxvdy4gVHJ1c3QgaXMgaW1wbGljaXQgaW4gLXAgbW9kZVxuICAgICAgICAvLyAoc2FtZSBnYXRlIGFzIHByZWZldGNoU3lzdGVtQ29udGV4dElmU2FmZSkuXG4gICAgICAgIHZvaWQgZ2V0U3lzdGVtQ29udGV4dCgpXG4gICAgICAgIC8vIEtpY2sgZ2V0VXNlckNvbnRleHQgbm93IHRvbyBcdTIwMTQgaXRzIGZpcnN0IGF3YWl0IChmcy5yZWFkRmlsZSBpblxuICAgICAgICAvLyBnZXRNZW1vcnlGaWxlcykgeWllbGRzIG5hdHVyYWxseSwgc28gdGhlIENMQVVERS5tZCBkaXJlY3Rvcnkgd2Fsa1xuICAgICAgICAvLyBydW5zIGR1cmluZyB0aGUgfjI4MG1zIG92ZXJsYXAgd2luZG93IGJlZm9yZSB0aGUgY29udGV4dFxuICAgICAgICAvLyBQcm9taXNlLmFsbCBqb2luIGluIHByaW50LnRzLiBUaGUgdm9pZCBnZXRVc2VyQ29udGV4dCgpIGluXG4gICAgICAgIC8vIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzIGJlY29tZXMgYSBtZW1vaXplIGNhY2hlLWhpdC5cbiAgICAgICAgdm9pZCBnZXRVc2VyQ29udGV4dCgpXG4gICAgICAgIC8vIEtpY2sgZW5zdXJlTW9kZWxTdHJpbmdzSW5pdGlhbGl6ZWQgbm93IFx1MjAxNCBmb3IgQmVkcm9jayB0aGlzIHRyaWdnZXJzXG4gICAgICAgIC8vIGEgMTAwLTIwMG1zIHByb2ZpbGUgZmV0Y2ggdGhhdCB3YXMgYXdhaXRlZCBzZXJpYWxseSBhdFxuICAgICAgICAvLyBwcmludC50czo3MzkuIHVwZGF0ZUJlZHJvY2tNb2RlbFN0cmluZ3MgaXMgc2VxdWVudGlhbCgpLXdyYXBwZWQgc29cbiAgICAgICAgLy8gdGhlIGF3YWl0IGpvaW5zIHRoZSBpbi1mbGlnaHQgZmV0Y2guIE5vbi1CZWRyb2NrIGlzIGEgc3luY1xuICAgICAgICAvLyBlYXJseS1yZXR1cm4gKHplcm8tY29zdCkuXG4gICAgICAgIHZvaWQgZW5zdXJlTW9kZWxTdHJpbmdzSW5pdGlhbGl6ZWQoKVxuICAgICAgfVxuXG4gICAgICAvLyBBcHBseSAtLW5hbWU6IGNhY2hlLW9ubHkgc28gbm8gb3JwaGFuIGZpbGUgaXMgY3JlYXRlZCBiZWZvcmUgdGhlXG4gICAgICAvLyBzZXNzaW9uIElEIGlzIGZpbmFsaXplZCBieSAtLWNvbnRpbnVlLy0tcmVzdW1lLiBtYXRlcmlhbGl6ZVNlc3Npb25GaWxlXG4gICAgICAvLyBwZXJzaXN0cyBpdCBvbiB0aGUgZmlyc3QgdXNlciBtZXNzYWdlOyBSRVBMJ3MgdXNlVGVybWluYWxUaXRsZSByZWFkcyBpdFxuICAgICAgLy8gdmlhIGdldEN1cnJlbnRTZXNzaW9uVGl0bGUuXG4gICAgICBjb25zdCBzZXNzaW9uTmFtZUFyZyA9IG9wdGlvbnMubmFtZT8udHJpbSgpXG4gICAgICBpZiAoc2Vzc2lvbk5hbWVBcmcpIHtcbiAgICAgICAgY2FjaGVTZXNzaW9uVGl0bGUoc2Vzc2lvbk5hbWVBcmcpXG4gICAgICB9XG5cbiAgICAgIC8vIEFudCBtb2RlbCBhbGlhc2VzIChjYXB5YmFyYS1mYXN0IGV0Yy4pIHJlc29sdmUgdmlhIHRoZVxuICAgICAgLy8gdGVuZ3VfYW50X21vZGVsX292ZXJyaWRlIEdyb3d0aEJvb2sgZmxhZy4gX0NBQ0hFRF9NQVlfQkVfU1RBTEUgcmVhZHNcbiAgICAgIC8vIGRpc2sgc3luY2hyb25vdXNseTsgZGlzayBpcyBwb3B1bGF0ZWQgYnkgYSBmaXJlLWFuZC1mb3JnZXQgd3JpdGUuIE9uIGFcbiAgICAgIC8vIGNvbGQgY2FjaGUsIHBhcnNlVXNlclNwZWNpZmllZE1vZGVsIHJldHVybnMgdGhlIHVucmVzb2x2ZWQgYWxpYXMsIHRoZVxuICAgICAgLy8gQVBJIDQwNHMsIGFuZCAtcCBleGl0cyBiZWZvcmUgdGhlIGFzeW5jIHdyaXRlIGxhbmRzIFx1MjAxNCBjcmFzaGxvb3Agb25cbiAgICAgIC8vIGZyZXNoIHBvZHMuIEF3YWl0aW5nIGluaXQgaGVyZSBwb3B1bGF0ZXMgdGhlIGluLW1lbW9yeSBwYXlsb2FkIG1hcCB0aGF0XG4gICAgICAvLyBfQ0FDSEVEX01BWV9CRV9TVEFMRSBub3cgY2hlY2tzIGZpcnN0LiBHYXRlZCBzbyB0aGUgd2FybSBwYXRoIHN0YXlzXG4gICAgICAvLyBub24tYmxvY2tpbmc6XG4gICAgICAvLyAgLSBleHBsaWNpdCBtb2RlbCB2aWEgLS1tb2RlbCBvciBBTlRIUk9QSUNfTU9ERUwgKGJvdGggZmVlZCBhbGlhcyByZXNvbHV0aW9uKVxuICAgICAgLy8gIC0gbm8gZW52IG92ZXJyaWRlICh3aGljaCBzaG9ydC1jaXJjdWl0cyBfQ0FDSEVEX01BWV9CRV9TVEFMRSBiZWZvcmUgZGlzaylcbiAgICAgIC8vICAtIGZsYWcgYWJzZW50IGZyb20gZGlzayAoPT0gbnVsbCBhbHNvIGNhdGNoZXMgcHJlLSMyMjI3OSBwb2lzb25lZCBudWxsKVxuICAgICAgY29uc3QgZXhwbGljaXRNb2RlbCA9IG9wdGlvbnMubW9kZWwgfHwgcHJvY2Vzcy5lbnYuQU5USFJPUElDX01PREVMXG4gICAgICBpZiAoXG4gICAgICAgIFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcgJiZcbiAgICAgICAgZXhwbGljaXRNb2RlbCAmJlxuICAgICAgICBleHBsaWNpdE1vZGVsICE9PSAnZGVmYXVsdCcgJiZcbiAgICAgICAgIWhhc0dyb3d0aEJvb2tFbnZPdmVycmlkZSgndGVuZ3VfYW50X21vZGVsX292ZXJyaWRlJykgJiZcbiAgICAgICAgZ2V0R2xvYmFsQ29uZmlnKCkuY2FjaGVkR3Jvd3RoQm9va0ZlYXR1cmVzPy5bXG4gICAgICAgICAgJ3Rlbmd1X2FudF9tb2RlbF9vdmVycmlkZSdcbiAgICAgICAgXSA9PSBudWxsXG4gICAgICApIHtcbiAgICAgICAgYXdhaXQgaW5pdGlhbGl6ZUdyb3d0aEJvb2soKVxuICAgICAgfVxuXG4gICAgICAvLyBTcGVjaWFsIGNhc2UgdGhlIGRlZmF1bHQgbW9kZWwgd2l0aCB0aGUgbnVsbCBrZXl3b3JkXG4gICAgICAvLyBOT1RFOiBNb2RlbCByZXNvbHV0aW9uIGhhcHBlbnMgYWZ0ZXIgc2V0dXAoKSB0byBlbnN1cmUgdHJ1c3QgaXMgZXN0YWJsaXNoZWQgYmVmb3JlIEFXUyBhdXRoXG4gICAgICBjb25zdCB1c2VyU3BlY2lmaWVkTW9kZWwgPVxuICAgICAgICBvcHRpb25zLm1vZGVsID09PSAnZGVmYXVsdCcgPyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpIDogb3B0aW9ucy5tb2RlbFxuICAgICAgY29uc3QgdXNlclNwZWNpZmllZEZhbGxiYWNrTW9kZWwgPVxuICAgICAgICBmYWxsYmFja01vZGVsID09PSAnZGVmYXVsdCcgPyBnZXREZWZhdWx0TWFpbkxvb3BNb2RlbCgpIDogZmFsbGJhY2tNb2RlbFxuXG4gICAgICAvLyBSZXVzZSBwcmVTZXR1cEN3ZCB1bmxlc3Mgc2V0dXAoKSBjaGRpcidkICh3b3JrdHJlZUVuYWJsZWQpLiBTYXZlcyBhXG4gICAgICAvLyBnZXRDd2QoKSBzeXNjYWxsIGluIHRoZSBjb21tb24gcGF0aC5cbiAgICAgIGNvbnN0IGN1cnJlbnRDd2QgPSB3b3JrdHJlZUVuYWJsZWQgPyBnZXRDd2QoKSA6IHByZVNldHVwQ3dkXG4gICAgICBsb2dGb3JEZWJ1Z2dpbmcoJ1tTVEFSVFVQXSBMb2FkaW5nIGNvbW1hbmRzIGFuZCBhZ2VudHMuLi4nKVxuICAgICAgY29uc3QgY29tbWFuZHNTdGFydCA9IERhdGUubm93KClcbiAgICAgIC8vIEpvaW4gdGhlIHByb21pc2VzIGtpY2tlZCBiZWZvcmUgc2V0dXAoKSAob3Igc3RhcnQgZnJlc2ggaWZcbiAgICAgIC8vIHdvcmt0cmVlRW5hYmxlZCBnYXRlZCB0aGUgZWFybHkga2ljaykuIEJvdGggbWVtb2l6ZWQgYnkgY3dkLlxuICAgICAgY29uc3QgW2NvbW1hbmRzLCBhZ2VudERlZmluaXRpb25zUmVzdWx0XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgY29tbWFuZHNQcm9taXNlID8/IGdldENvbW1hbmRzKGN1cnJlbnRDd2QpLFxuICAgICAgICBhZ2VudERlZnNQcm9taXNlID8/IGdldEFnZW50RGVmaW5pdGlvbnNXaXRoT3ZlcnJpZGVzKGN1cnJlbnRDd2QpLFxuICAgICAgXSlcbiAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgYFtTVEFSVFVQXSBDb21tYW5kcyBhbmQgYWdlbnRzIGxvYWRlZCBpbiAke0RhdGUubm93KCkgLSBjb21tYW5kc1N0YXJ0fW1zYCxcbiAgICAgIClcbiAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhY3Rpb25fY29tbWFuZHNfbG9hZGVkJylcblxuICAgICAgLy8gUGFyc2UgQ0xJIGFnZW50cyBpZiBwcm92aWRlZCB2aWEgLS1hZ2VudHMgZmxhZ1xuICAgICAgbGV0IGNsaUFnZW50czogdHlwZW9mIGFnZW50RGVmaW5pdGlvbnNSZXN1bHQuYWN0aXZlQWdlbnRzID0gW11cbiAgICAgIGlmIChhZ2VudHNKc29uKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgcGFyc2VkQWdlbnRzID0gc2FmZVBhcnNlSlNPTihhZ2VudHNKc29uKVxuICAgICAgICAgIGlmIChwYXJzZWRBZ2VudHMpIHtcbiAgICAgICAgICAgIGNsaUFnZW50cyA9IHBhcnNlQWdlbnRzRnJvbUpzb24ocGFyc2VkQWdlbnRzLCAnZmxhZ1NldHRpbmdzJylcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gTWVyZ2UgQ0xJIGFnZW50cyB3aXRoIGV4aXN0aW5nIG9uZXNcbiAgICAgIGNvbnN0IGFsbEFnZW50cyA9IFsuLi5hZ2VudERlZmluaXRpb25zUmVzdWx0LmFsbEFnZW50cywgLi4uY2xpQWdlbnRzXVxuICAgICAgY29uc3QgYWdlbnREZWZpbml0aW9ucyA9IHtcbiAgICAgICAgLi4uYWdlbnREZWZpbml0aW9uc1Jlc3VsdCxcbiAgICAgICAgYWxsQWdlbnRzLFxuICAgICAgICBhY3RpdmVBZ2VudHM6IGdldEFjdGl2ZUFnZW50c0Zyb21MaXN0KGFsbEFnZW50cyksXG4gICAgICB9XG5cbiAgICAgIC8vIExvb2sgdXAgbWFpbiB0aHJlYWQgYWdlbnQgZnJvbSBDTEkgZmxhZyBvciBzZXR0aW5nc1xuICAgICAgY29uc3QgYWdlbnRTZXR0aW5nID0gYWdlbnRDbGkgPz8gZ2V0SW5pdGlhbFNldHRpbmdzKCkuYWdlbnRcbiAgICAgIGxldCBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uOlxuICAgICAgICB8ICh0eXBlb2YgYWdlbnREZWZpbml0aW9ucy5hY3RpdmVBZ2VudHMpW251bWJlcl1cbiAgICAgICAgfCB1bmRlZmluZWRcbiAgICAgIGlmIChhZ2VudFNldHRpbmcpIHtcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbiA9IGFnZW50RGVmaW5pdGlvbnMuYWN0aXZlQWdlbnRzLmZpbmQoXG4gICAgICAgICAgYWdlbnQgPT4gYWdlbnQuYWdlbnRUeXBlID09PSBhZ2VudFNldHRpbmcsXG4gICAgICAgIClcbiAgICAgICAgaWYgKCFtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uKSB7XG4gICAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgICAgYFdhcm5pbmc6IGFnZW50IFwiJHthZ2VudFNldHRpbmd9XCIgbm90IGZvdW5kLiBgICtcbiAgICAgICAgICAgICAgYEF2YWlsYWJsZSBhZ2VudHM6ICR7YWdlbnREZWZpbml0aW9ucy5hY3RpdmVBZ2VudHMubWFwKGEgPT4gYS5hZ2VudFR5cGUpLmpvaW4oJywgJyl9LiBgICtcbiAgICAgICAgICAgICAgYFVzaW5nIGRlZmF1bHQgYmVoYXZpb3IuYCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gU3RvcmUgdGhlIG1haW4gdGhyZWFkIGFnZW50IHR5cGUgaW4gYm9vdHN0cmFwIHN0YXRlIHNvIGhvb2tzIGNhbiBhY2Nlc3MgaXRcbiAgICAgIHNldE1haW5UaHJlYWRBZ2VudFR5cGUobWFpblRocmVhZEFnZW50RGVmaW5pdGlvbj8uYWdlbnRUeXBlKVxuXG4gICAgICAvLyBMb2cgYWdlbnQgZmxhZyB1c2FnZSBcdTIwMTQgb25seSBsb2cgYWdlbnQgbmFtZSBmb3IgYnVpbHQtaW4gYWdlbnRzIHRvIGF2b2lkIGxlYWtpbmcgY3VzdG9tIGFnZW50IG5hbWVzXG4gICAgICBpZiAobWFpblRocmVhZEFnZW50RGVmaW5pdGlvbikge1xuICAgICAgICBsb2dFdmVudCgndGVuZ3VfYWdlbnRfZmxhZycsIHtcbiAgICAgICAgICBhZ2VudFR5cGU6IGlzQnVpbHRJbkFnZW50KG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24pXG4gICAgICAgICAgICA/IChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLmFnZW50VHlwZSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTKVxuICAgICAgICAgICAgOiAoJ2N1c3RvbScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyksXG4gICAgICAgICAgLi4uKGFnZW50Q2xpICYmIHtcbiAgICAgICAgICAgIHNvdXJjZTpcbiAgICAgICAgICAgICAgJ2NsaScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICB9KSxcbiAgICAgICAgfSlcbiAgICAgIH1cblxuICAgICAgLy8gUGVyc2lzdCBhZ2VudCBzZXR0aW5nIHRvIHNlc3Npb24gdHJhbnNjcmlwdCBmb3IgcmVzdW1lIHZpZXcgZGlzcGxheSBhbmQgcmVzdG9yYXRpb25cbiAgICAgIGlmIChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uPy5hZ2VudFR5cGUpIHtcbiAgICAgICAgc2F2ZUFnZW50U2V0dGluZyhtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLmFnZW50VHlwZSlcbiAgICAgIH1cblxuICAgICAgLy8gQXBwbHkgdGhlIGFnZW50J3Mgc3lzdGVtIHByb21wdCBmb3Igbm9uLWludGVyYWN0aXZlIHNlc3Npb25zXG4gICAgICAvLyAoaW50ZXJhY3RpdmUgbW9kZSB1c2VzIGJ1aWxkRWZmZWN0aXZlU3lzdGVtUHJvbXB0IGluc3RlYWQpXG4gICAgICBpZiAoXG4gICAgICAgIGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uICYmXG4gICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gJiZcbiAgICAgICAgIXN5c3RlbVByb21wdCAmJlxuICAgICAgICAhaXNCdWlsdEluQWdlbnQobWFpblRocmVhZEFnZW50RGVmaW5pdGlvbilcbiAgICAgICkge1xuICAgICAgICBjb25zdCBhZ2VudFN5c3RlbVByb21wdCA9IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24uZ2V0U3lzdGVtUHJvbXB0KClcbiAgICAgICAgaWYgKGFnZW50U3lzdGVtUHJvbXB0KSB7XG4gICAgICAgICAgc3lzdGVtUHJvbXB0ID0gYWdlbnRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBpbml0aWFsUHJvbXB0IGdvZXMgZmlyc3Qgc28gaXRzIHNsYXNoIGNvbW1hbmQgKGlmIGFueSkgaXMgcHJvY2Vzc2VkO1xuICAgICAgLy8gdXNlci1wcm92aWRlZCB0ZXh0IGJlY29tZXMgdHJhaWxpbmcgY29udGV4dC5cbiAgICAgIC8vIE9ubHkgY29uY2F0ZW5hdGUgd2hlbiBpbnB1dFByb21wdCBpcyBhIHN0cmluZy4gV2hlbiBpdCdzIGFuXG4gICAgICAvLyBBc3luY0l0ZXJhYmxlIChTREsgc3RyZWFtLWpzb24gbW9kZSksIHRlbXBsYXRlIGludGVycG9sYXRpb24gd291bGRcbiAgICAgIC8vIGNhbGwgLnRvU3RyaW5nKCkgcHJvZHVjaW5nIFwiW29iamVjdCBPYmplY3RdXCIuIFRoZSBBc3luY0l0ZXJhYmxlIGNhc2VcbiAgICAgIC8vIGlzIGhhbmRsZWQgaW4gcHJpbnQudHMgdmlhIHN0cnVjdHVyZWRJTy5wcmVwZW5kVXNlck1lc3NhZ2UoKS5cbiAgICAgIGlmIChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uPy5pbml0aWFsUHJvbXB0KSB7XG4gICAgICAgIGlmICh0eXBlb2YgaW5wdXRQcm9tcHQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgaW5wdXRQcm9tcHQgPSBpbnB1dFByb21wdFxuICAgICAgICAgICAgPyBgJHttYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLmluaXRpYWxQcm9tcHR9XFxuXFxuJHtpbnB1dFByb21wdH1gXG4gICAgICAgICAgICA6IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24uaW5pdGlhbFByb21wdFxuICAgICAgICB9IGVsc2UgaWYgKCFpbnB1dFByb21wdCkge1xuICAgICAgICAgIGlucHV0UHJvbXB0ID0gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5pbml0aWFsUHJvbXB0XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gQ29tcHV0ZSBlZmZlY3RpdmUgbW9kZWwgZWFybHkgc28gaG9va3MgY2FuIHJ1biBpbiBwYXJhbGxlbCB3aXRoIE1DUFxuICAgICAgLy8gSWYgdXNlciBkaWRuJ3Qgc3BlY2lmeSBhIG1vZGVsIGJ1dCBhZ2VudCBoYXMgb25lLCB1c2UgdGhlIGFnZW50J3MgbW9kZWxcbiAgICAgIGxldCBlZmZlY3RpdmVNb2RlbCA9IHVzZXJTcGVjaWZpZWRNb2RlbFxuICAgICAgaWYgKFxuICAgICAgICAhZWZmZWN0aXZlTW9kZWwgJiZcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbj8ubW9kZWwgJiZcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5tb2RlbCAhPT0gJ2luaGVyaXQnXG4gICAgICApIHtcbiAgICAgICAgZWZmZWN0aXZlTW9kZWwgPSBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbChcbiAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLm1vZGVsLFxuICAgICAgICApXG4gICAgICB9XG5cbiAgICAgIHNldE1haW5Mb29wTW9kZWxPdmVycmlkZShlZmZlY3RpdmVNb2RlbClcblxuICAgICAgLy8gQ29tcHV0ZSByZXNvbHZlZCBtb2RlbCBmb3IgaG9va3MgKHVzZSB1c2VyLXNwZWNpZmllZCBtb2RlbCBhdCBsYXVuY2gpXG4gICAgICBzZXRJbml0aWFsTWFpbkxvb3BNb2RlbChnZXRVc2VyU3BlY2lmaWVkTW9kZWxTZXR0aW5nKCkgfHwgbnVsbClcbiAgICAgIGNvbnN0IGluaXRpYWxNYWluTG9vcE1vZGVsID0gZ2V0SW5pdGlhbE1haW5Mb29wTW9kZWwoKVxuICAgICAgY29uc3QgcmVzb2x2ZWRJbml0aWFsTW9kZWwgPSBwYXJzZVVzZXJTcGVjaWZpZWRNb2RlbChcbiAgICAgICAgaW5pdGlhbE1haW5Mb29wTW9kZWwgPz8gZ2V0RGVmYXVsdE1haW5Mb29wTW9kZWwoKSxcbiAgICAgIClcblxuICAgICAgbGV0IGFkdmlzb3JNb2RlbDogc3RyaW5nIHwgdW5kZWZpbmVkXG4gICAgICBpZiAoaXNBZHZpc29yRW5hYmxlZCgpKSB7XG4gICAgICAgIGNvbnN0IGFkdmlzb3JPcHRpb24gPSBjYW5Vc2VyQ29uZmlndXJlQWR2aXNvcigpXG4gICAgICAgICAgPyAob3B0aW9ucyBhcyB7IGFkdmlzb3I/OiBzdHJpbmcgfSkuYWR2aXNvclxuICAgICAgICAgIDogdW5kZWZpbmVkXG4gICAgICAgIGlmIChhZHZpc29yT3B0aW9uKSB7XG4gICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBbQWR2aXNvclRvb2xdIC0tYWR2aXNvciAke2Fkdmlzb3JPcHRpb259YClcbiAgICAgICAgICBpZiAoIW1vZGVsU3VwcG9ydHNBZHZpc29yKHJlc29sdmVkSW5pdGlhbE1vZGVsKSkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICBgRXJyb3I6IFRoZSBtb2RlbCBcIiR7cmVzb2x2ZWRJbml0aWFsTW9kZWx9XCIgZG9lcyBub3Qgc3VwcG9ydCB0aGUgYWR2aXNvciB0b29sLlxcbmAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3Qgbm9ybWFsaXplZEFkdmlzb3JNb2RlbCA9IG5vcm1hbGl6ZU1vZGVsU3RyaW5nRm9yQVBJKFxuICAgICAgICAgICAgcGFyc2VVc2VyU3BlY2lmaWVkTW9kZWwoYWR2aXNvck9wdGlvbiksXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmICghaXNWYWxpZEFkdmlzb3JNb2RlbChub3JtYWxpemVkQWR2aXNvck1vZGVsKSkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICBgRXJyb3I6IFRoZSBtb2RlbCBcIiR7YWR2aXNvck9wdGlvbn1cIiBjYW5ub3QgYmUgdXNlZCBhcyBhbiBhZHZpc29yLlxcbmAsXG4gICAgICAgICAgICAgICksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgYWR2aXNvck1vZGVsID0gY2FuVXNlckNvbmZpZ3VyZUFkdmlzb3IoKVxuICAgICAgICAgID8gKGFkdmlzb3JPcHRpb24gPz8gZ2V0SW5pdGlhbEFkdmlzb3JTZXR0aW5nKCkpXG4gICAgICAgICAgOiBhZHZpc29yT3B0aW9uXG4gICAgICAgIGlmIChhZHZpc29yTW9kZWwpIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoYFtBZHZpc29yVG9vbF0gQWR2aXNvciBtb2RlbDogJHthZHZpc29yTW9kZWx9YClcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBGb3IgdG11eCB0ZWFtbWF0ZXMgd2l0aCAtLWFnZW50LXR5cGUsIGFwcGVuZCB0aGUgY3VzdG9tIGFnZW50J3MgcHJvbXB0XG4gICAgICBpZiAoXG4gICAgICAgIGlzQWdlbnRTd2FybXNFbmFibGVkKCkgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy5hZ2VudElkICYmXG4gICAgICAgIHN0b3JlZFRlYW1tYXRlT3B0cz8uYWdlbnROYW1lICYmXG4gICAgICAgIHN0b3JlZFRlYW1tYXRlT3B0cz8udGVhbU5hbWUgJiZcbiAgICAgICAgc3RvcmVkVGVhbW1hdGVPcHRzPy5hZ2VudFR5cGVcbiAgICAgICkge1xuICAgICAgICAvLyBMb29rIHVwIHRoZSBjdXN0b20gYWdlbnQgZGVmaW5pdGlvblxuICAgICAgICBjb25zdCBjdXN0b21BZ2VudCA9IGFnZW50RGVmaW5pdGlvbnMuYWN0aXZlQWdlbnRzLmZpbmQoXG4gICAgICAgICAgYSA9PiBhLmFnZW50VHlwZSA9PT0gc3RvcmVkVGVhbW1hdGVPcHRzLmFnZW50VHlwZSxcbiAgICAgICAgKVxuICAgICAgICBpZiAoY3VzdG9tQWdlbnQpIHtcbiAgICAgICAgICAvLyBHZXQgdGhlIHByb21wdCAtIG5lZWQgdG8gaGFuZGxlIGJvdGggYnVpbHQtaW4gYW5kIGN1c3RvbSBhZ2VudHNcbiAgICAgICAgICBsZXQgY3VzdG9tUHJvbXB0OiBzdHJpbmcgfCB1bmRlZmluZWRcbiAgICAgICAgICBpZiAoY3VzdG9tQWdlbnQuc291cmNlID09PSAnYnVpbHQtaW4nKSB7XG4gICAgICAgICAgICAvLyBCdWlsdC1pbiBhZ2VudHMgaGF2ZSBnZXRTeXN0ZW1Qcm9tcHQgdGhhdCB0YWtlcyB0b29sVXNlQ29udGV4dFxuICAgICAgICAgICAgLy8gV2UgY2FuJ3QgYWNjZXNzIGZ1bGwgdG9vbFVzZUNvbnRleHQgaGVyZSwgc28gc2tpcCBmb3Igbm93XG4gICAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICAgIGBbdGVhbW1hdGVdIEJ1aWx0LWluIGFnZW50ICR7c3RvcmVkVGVhbW1hdGVPcHRzLmFnZW50VHlwZX0gLSBza2lwcGluZyBjdXN0b20gcHJvbXB0IChub3Qgc3VwcG9ydGVkKWAsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vIEN1c3RvbSBhZ2VudHMgaGF2ZSBnZXRTeXN0ZW1Qcm9tcHQgdGhhdCB0YWtlcyBubyBhcmdzXG4gICAgICAgICAgICBjdXN0b21Qcm9tcHQgPSBjdXN0b21BZ2VudC5nZXRTeXN0ZW1Qcm9tcHQoKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIExvZyBhZ2VudCBtZW1vcnkgbG9hZGVkIGV2ZW50IGZvciB0bXV4IHRlYW1tYXRlc1xuICAgICAgICAgIGlmIChjdXN0b21BZ2VudC5tZW1vcnkpIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9hZ2VudF9tZW1vcnlfbG9hZGVkJywge1xuICAgICAgICAgICAgICAuLi4oXCJleHRlcm5hbFwiID09PSAnYW50JyAmJiB7XG4gICAgICAgICAgICAgICAgYWdlbnRfdHlwZTpcbiAgICAgICAgICAgICAgICAgIGN1c3RvbUFnZW50LmFnZW50VHlwZSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICB9KSxcbiAgICAgICAgICAgICAgc2NvcGU6XG4gICAgICAgICAgICAgICAgY3VzdG9tQWdlbnQubWVtb3J5IGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgIHNvdXJjZTpcbiAgICAgICAgICAgICAgICAndGVhbW1hdGUnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgIH1cblxuICAgICAgICAgIGlmIChjdXN0b21Qcm9tcHQpIHtcbiAgICAgICAgICAgIGNvbnN0IGN1c3RvbUluc3RydWN0aW9ucyA9IGBcXG4jIEN1c3RvbSBBZ2VudCBJbnN0cnVjdGlvbnNcXG4ke2N1c3RvbVByb21wdH1gXG4gICAgICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQgPSBhcHBlbmRTeXN0ZW1Qcm9tcHRcbiAgICAgICAgICAgICAgPyBgJHthcHBlbmRTeXN0ZW1Qcm9tcHR9XFxuXFxuJHtjdXN0b21JbnN0cnVjdGlvbnN9YFxuICAgICAgICAgICAgICA6IGN1c3RvbUluc3RydWN0aW9uc1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgW3RlYW1tYXRlXSBDdXN0b20gYWdlbnQgJHtzdG9yZWRUZWFtbWF0ZU9wdHMuYWdlbnRUeXBlfSBub3QgZm91bmQgaW4gYXZhaWxhYmxlIGFnZW50c2AsXG4gICAgICAgICAgKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIG1heWJlQWN0aXZhdGVCcmllZihvcHRpb25zKVxuICAgICAgLy8gZGVmYXVsdFZpZXc6ICdjaGF0JyBpcyBhIHBlcnNpc3RlZCBvcHQtaW4gXHUyMDE0IGNoZWNrIGVudGl0bGVtZW50IGFuZCBzZXRcbiAgICAgIC8vIHVzZXJNc2dPcHRJbiBzbyB0aGUgdG9vbCArIHByb21wdCBzZWN0aW9uIGFjdGl2YXRlLiBJbnRlcmFjdGl2ZS1vbmx5OlxuICAgICAgLy8gZGVmYXVsdFZpZXcgaXMgYSBkaXNwbGF5IHByZWZlcmVuY2U7IFNESyBzZXNzaW9ucyBoYXZlIG5vIGRpc3BsYXksIGFuZFxuICAgICAgLy8gdGhlIGFzc2lzdGFudCBpbnN0YWxsZXIgd3JpdGVzIGRlZmF1bHRWaWV3OidjaGF0JyB0byBzZXR0aW5ncy5sb2NhbC5qc29uXG4gICAgICAvLyB3aGljaCB3b3VsZCBvdGhlcndpc2UgbGVhayBpbnRvIC0tcHJpbnQgc2Vzc2lvbnMgaW4gdGhlIHNhbWUgZGlyZWN0b3J5LlxuICAgICAgLy8gUnVucyByaWdodCBhZnRlciBtYXliZUFjdGl2YXRlQnJpZWYoKSBzbyBhbGwgc3RhcnR1cCBvcHQtaW4gcGF0aHMgZmlyZVxuICAgICAgLy8gQkVGT1JFIGFueSBpc0JyaWVmRW5hYmxlZCgpIHJlYWQgYmVsb3cgKHByb2FjdGl2ZSBwcm9tcHQnc1xuICAgICAgLy8gYnJpZWZWaXNpYmlsaXR5KS4gQSBwZXJzaXN0ZWQgJ2NoYXQnIGFmdGVyIGEgR0Iga2lsbC1zd2l0Y2ggZmFsbHNcbiAgICAgIC8vIHRocm91Z2ggKGVudGl0bGVtZW50IGZhaWxzKS5cbiAgICAgIGlmIChcbiAgICAgICAgKGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19CUklFRicpKSAmJlxuICAgICAgICAhZ2V0SXNOb25JbnRlcmFjdGl2ZVNlc3Npb24oKSAmJlxuICAgICAgICAhZ2V0VXNlck1zZ09wdEluKCkgJiZcbiAgICAgICAgZ2V0SW5pdGlhbFNldHRpbmdzKCkuZGVmYXVsdFZpZXcgPT09ICdjaGF0J1xuICAgICAgKSB7XG4gICAgICAgIC8qIGVzbGludC1kaXNhYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbiAgICAgICAgY29uc3QgeyBpc0JyaWVmRW50aXRsZWQgfSA9XG4gICAgICAgICAgcmVxdWlyZSgnLi90b29scy9CcmllZlRvb2wvQnJpZWZUb29sLmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi90b29scy9CcmllZlRvb2wvQnJpZWZUb29sLmpzJylcbiAgICAgICAgLyogZXNsaW50LWVuYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4gICAgICAgIGlmIChpc0JyaWVmRW50aXRsZWQoKSkge1xuICAgICAgICAgIHNldFVzZXJNc2dPcHRJbih0cnVlKVxuICAgICAgICB9XG4gICAgICB9XG4gICAgICAvLyBDb29yZGluYXRvciBtb2RlIGhhcyBpdHMgb3duIHN5c3RlbSBwcm9tcHQgYW5kIGZpbHRlcnMgb3V0IFNsZWVwLCBzb1xuICAgICAgLy8gdGhlIGdlbmVyaWMgcHJvYWN0aXZlIHByb21wdCB3b3VsZCB0ZWxsIGl0IHRvIGNhbGwgYSB0b29sIGl0IGNhbid0XG4gICAgICAvLyBhY2Nlc3MgYW5kIGNvbmZsaWN0IHdpdGggZGVsZWdhdGlvbiBpbnN0cnVjdGlvbnMuXG4gICAgICBpZiAoXG4gICAgICAgIChmZWF0dXJlKCdQUk9BQ1RJVkUnKSB8fCBmZWF0dXJlKCdLQUlST1MnKSkgJiZcbiAgICAgICAgKChvcHRpb25zIGFzIHsgcHJvYWN0aXZlPzogYm9vbGVhbiB9KS5wcm9hY3RpdmUgfHxcbiAgICAgICAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9QUk9BQ1RJVkUpKSAmJlxuICAgICAgICAhY29vcmRpbmF0b3JNb2RlTW9kdWxlPy5pc0Nvb3JkaW5hdG9yTW9kZSgpXG4gICAgICApIHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCBicmllZlZpc2liaWxpdHkgPVxuICAgICAgICAgIGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19CUklFRicpXG4gICAgICAgICAgICA/IChcbiAgICAgICAgICAgICAgICByZXF1aXJlKCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKSBhcyB0eXBlb2YgaW1wb3J0KCcuL3Rvb2xzL0JyaWVmVG9vbC9CcmllZlRvb2wuanMnKVxuICAgICAgICAgICAgICApLmlzQnJpZWZFbmFibGVkKClcbiAgICAgICAgICAgICAgPyAnQ2FsbCBTZW5kVXNlck1lc3NhZ2UgYXQgY2hlY2twb2ludHMgdG8gbWFyayB3aGVyZSB0aGluZ3Mgc3RhbmQuJ1xuICAgICAgICAgICAgICA6ICdUaGUgdXNlciB3aWxsIHNlZSBhbnkgdGV4dCB5b3Ugb3V0cHV0LidcbiAgICAgICAgICAgIDogJ1RoZSB1c2VyIHdpbGwgc2VlIGFueSB0ZXh0IHlvdSBvdXRwdXQuJ1xuICAgICAgICAvKiBlc2xpbnQtZW5hYmxlIEB0eXBlc2NyaXB0LWVzbGludC9uby1yZXF1aXJlLWltcG9ydHMgKi9cbiAgICAgICAgY29uc3QgcHJvYWN0aXZlUHJvbXB0ID0gYFxcbiMgUHJvYWN0aXZlIE1vZGVcXG5cXG5Zb3UgYXJlIGluIHByb2FjdGl2ZSBtb2RlLiBUYWtlIGluaXRpYXRpdmUgXHUyMDE0IGV4cGxvcmUsIGFjdCwgYW5kIG1ha2UgcHJvZ3Jlc3Mgd2l0aG91dCB3YWl0aW5nIGZvciBpbnN0cnVjdGlvbnMuXFxuXFxuU3RhcnQgYnkgYnJpZWZseSBncmVldGluZyB0aGUgdXNlci5cXG5cXG5Zb3Ugd2lsbCByZWNlaXZlIHBlcmlvZGljIDx0aWNrPiBwcm9tcHRzLiBUaGVzZSBhcmUgY2hlY2staW5zLiBEbyB3aGF0ZXZlciBzZWVtcyBtb3N0IHVzZWZ1bCwgb3IgY2FsbCBTbGVlcCBpZiB0aGVyZSdzIG5vdGhpbmcgdG8gZG8uICR7YnJpZWZWaXNpYmlsaXR5fWBcbiAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0ID0gYXBwZW5kU3lzdGVtUHJvbXB0XG4gICAgICAgICAgPyBgJHthcHBlbmRTeXN0ZW1Qcm9tcHR9XFxuXFxuJHtwcm9hY3RpdmVQcm9tcHR9YFxuICAgICAgICAgIDogcHJvYWN0aXZlUHJvbXB0XG4gICAgICB9XG5cbiAgICAgIGlmIChmZWF0dXJlKCdLQUlST1MnKSAmJiBrYWlyb3NFbmFibGVkICYmIGFzc2lzdGFudE1vZHVsZSkge1xuICAgICAgICBjb25zdCBhc3Npc3RhbnRBZGRlbmR1bSA9XG4gICAgICAgICAgYXNzaXN0YW50TW9kdWxlLmdldEFzc2lzdGFudFN5c3RlbVByb21wdEFkZGVuZHVtKClcbiAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0ID0gYXBwZW5kU3lzdGVtUHJvbXB0XG4gICAgICAgICAgPyBgJHthcHBlbmRTeXN0ZW1Qcm9tcHR9XFxuXFxuJHthc3Npc3RhbnRBZGRlbmR1bX1gXG4gICAgICAgICAgOiBhc3Npc3RhbnRBZGRlbmR1bVxuICAgICAgfVxuXG4gICAgICAvLyBJbmsgcm9vdCBpcyBvbmx5IG5lZWRlZCBmb3IgaW50ZXJhY3RpdmUgc2Vzc2lvbnMgXHUyMDE0IHBhdGNoQ29uc29sZSBpbiB0aGVcbiAgICAgIC8vIEluayBjb25zdHJ1Y3RvciB3b3VsZCBzd2FsbG93IGNvbnNvbGUgb3V0cHV0IGluIGhlYWRsZXNzIG1vZGUuXG4gICAgICBsZXQgcm9vdCE6IFJvb3RcbiAgICAgIGxldCBnZXRGcHNNZXRyaWNzITogKCkgPT4gRnBzTWV0cmljcyB8IHVuZGVmaW5lZFxuICAgICAgbGV0IHN0YXRzITogU3RhdHNTdG9yZVxuXG4gICAgICAvLyBTaG93IHNldHVwIHNjcmVlbnMgYWZ0ZXIgY29tbWFuZHMgYXJlIGxvYWRlZFxuICAgICAgaWYgKCFpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICBjb25zdCBjdHggPSBnZXRSZW5kZXJDb250ZXh0KGZhbHNlKVxuICAgICAgICBnZXRGcHNNZXRyaWNzID0gY3R4LmdldEZwc01ldHJpY3NcbiAgICAgICAgc3RhdHMgPSBjdHguc3RhdHNcbiAgICAgICAgLy8gSW5zdGFsbCBhc2NpaWNhc3QgcmVjb3JkZXIgYmVmb3JlIEluayBtb3VudHMgKGFudC1vbmx5LCBvcHQtaW4gdmlhIENMQVVERV9DT0RFX1RFUk1JTkFMX1JFQ09SRElORz0xKVxuICAgICAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgICAgICAgIGluc3RhbGxBc2NpaWNhc3RSZWNvcmRlcigpXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCB7IGNyZWF0ZVJvb3QgfSA9IGF3YWl0IGltcG9ydCgnLi9pbmsuanMnKVxuICAgICAgICByb290ID0gYXdhaXQgY3JlYXRlUm9vdChjdHgucmVuZGVyT3B0aW9ucylcblxuICAgICAgICAvLyBMb2cgc3RhcnR1cCB0aW1lIG5vdywgYmVmb3JlIGFueSBibG9ja2luZyBkaWFsb2cgcmVuZGVycy4gTG9nZ2luZ1xuICAgICAgICAvLyBmcm9tIFJFUEwncyBmaXJzdCByZW5kZXIgKHRoZSBvbGQgbG9jYXRpb24pIGluY2x1ZGVkIGhvd2V2ZXIgbG9uZ1xuICAgICAgICAvLyB0aGUgdXNlciBzYXQgb24gdHJ1c3QvT0F1dGgvb25ib2FyZGluZy9yZXN1bWUtcGlja2VyIFx1MjAxNCBwOTkgd2FzIH43MHNcbiAgICAgICAgLy8gZG9taW5hdGVkIGJ5IGRpYWxvZy13YWl0IHRpbWUsIG5vdCBjb2RlLXBhdGggc3RhcnR1cC5cbiAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3RpbWVyJywge1xuICAgICAgICAgIGV2ZW50OlxuICAgICAgICAgICAgJ3N0YXJ0dXAnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgZHVyYXRpb25NczogTWF0aC5yb3VuZChwcm9jZXNzLnVwdGltZSgpICogMTAwMCksXG4gICAgICAgIH0pXG5cbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKCdbU1RBUlRVUF0gUnVubmluZyBzaG93U2V0dXBTY3JlZW5zKCkuLi4nKVxuICAgICAgICBjb25zdCBzZXR1cFNjcmVlbnNTdGFydCA9IERhdGUubm93KClcbiAgICAgICAgY29uc3Qgb25ib2FyZGluZ1Nob3duID0gYXdhaXQgc2hvd1NldHVwU2NyZWVucyhcbiAgICAgICAgICByb290LFxuICAgICAgICAgIHBlcm1pc3Npb25Nb2RlLFxuICAgICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgICAgY29tbWFuZHMsXG4gICAgICAgICAgZW5hYmxlQ2xhdWRlSW5DaHJvbWUsXG4gICAgICAgICAgZGV2Q2hhbm5lbHMsXG4gICAgICAgIClcbiAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgIGBbU1RBUlRVUF0gc2hvd1NldHVwU2NyZWVucygpIGNvbXBsZXRlZCBpbiAke0RhdGUubm93KCkgLSBzZXR1cFNjcmVlbnNTdGFydH1tc2AsXG4gICAgICAgIClcblxuICAgICAgICAvLyBOb3cgdGhhdCB0cnVzdCBpcyBlc3RhYmxpc2hlZCBhbmQgR3Jvd3RoQm9vayBoYXMgYXV0aCBoZWFkZXJzLFxuICAgICAgICAvLyByZXNvbHZlIHRoZSAtLXJlbW90ZS1jb250cm9sIC8gLS1yYyBlbnRpdGxlbWVudCBnYXRlLlxuICAgICAgICBpZiAoZmVhdHVyZSgnQlJJREdFX01PREUnKSAmJiByZW1vdGVDb250cm9sT3B0aW9uICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjb25zdCB7IGdldEJyaWRnZURpc2FibGVkUmVhc29uIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9icmlkZ2UvYnJpZGdlRW5hYmxlZC5qcydcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3QgZGlzYWJsZWRSZWFzb24gPSBhd2FpdCBnZXRCcmlkZ2VEaXNhYmxlZFJlYXNvbigpXG4gICAgICAgICAgcmVtb3RlQ29udHJvbCA9IGRpc2FibGVkUmVhc29uID09PSBudWxsXG4gICAgICAgICAgaWYgKGRpc2FibGVkUmVhc29uKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgY2hhbGsueWVsbG93KGAke2Rpc2FibGVkUmVhc29ufVxcbi0tcmMgZmxhZyBpZ25vcmVkLlxcbmApLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIENoZWNrIGZvciBwZW5kaW5nIGFnZW50IG1lbW9yeSBzbmFwc2hvdCB1cGRhdGVzIChvbmx5IGZvciAtLWFnZW50IG1vZGUsIGFudC1vbmx5KVxuICAgICAgICBpZiAoXG4gICAgICAgICAgZmVhdHVyZSgnQUdFTlRfTUVNT1JZX1NOQVBTSE9UJykgJiZcbiAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uICYmXG4gICAgICAgICAgaXNDdXN0b21BZ2VudChtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uKSAmJlxuICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24ubWVtb3J5ICYmXG4gICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbi5wZW5kaW5nU25hcHNob3RVcGRhdGVcbiAgICAgICAgKSB7XG4gICAgICAgICAgY29uc3QgYWdlbnREZWYgPSBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uXG4gICAgICAgICAgY29uc3QgY2hvaWNlID0gYXdhaXQgbGF1bmNoU25hcHNob3RVcGRhdGVEaWFsb2cocm9vdCwge1xuICAgICAgICAgICAgYWdlbnRUeXBlOiBhZ2VudERlZi5hZ2VudFR5cGUsXG4gICAgICAgICAgICBzY29wZTogYWdlbnREZWYubWVtb3J5ISxcbiAgICAgICAgICAgIHNuYXBzaG90VGltZXN0YW1wOlxuICAgICAgICAgICAgICBhZ2VudERlZi5wZW5kaW5nU25hcHNob3RVcGRhdGUhLnNuYXBzaG90VGltZXN0YW1wLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgaWYgKGNob2ljZSA9PT0gJ21lcmdlJykge1xuICAgICAgICAgICAgY29uc3QgeyBidWlsZE1lcmdlUHJvbXB0IH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAgICcuL2NvbXBvbmVudHMvYWdlbnRzL1NuYXBzaG90VXBkYXRlRGlhbG9nLmpzJ1xuICAgICAgICAgICAgKVxuICAgICAgICAgICAgY29uc3QgbWVyZ2VQcm9tcHQgPSBidWlsZE1lcmdlUHJvbXB0KFxuICAgICAgICAgICAgICBhZ2VudERlZi5hZ2VudFR5cGUsXG4gICAgICAgICAgICAgIGFnZW50RGVmLm1lbW9yeSEsXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBpbnB1dFByb21wdCA9IGlucHV0UHJvbXB0XG4gICAgICAgICAgICAgID8gYCR7bWVyZ2VQcm9tcHR9XFxuXFxuJHtpbnB1dFByb21wdH1gXG4gICAgICAgICAgICAgIDogbWVyZ2VQcm9tcHRcbiAgICAgICAgICB9XG4gICAgICAgICAgYWdlbnREZWYucGVuZGluZ1NuYXBzaG90VXBkYXRlID0gdW5kZWZpbmVkXG4gICAgICAgIH1cblxuICAgICAgICAvLyBTa2lwIGV4ZWN1dGluZyAvbG9naW4gaWYgd2UganVzdCBjb21wbGV0ZWQgb25ib2FyZGluZyBmb3IgaXRcbiAgICAgICAgaWYgKG9uYm9hcmRpbmdTaG93biAmJiBwcm9tcHQ/LnRyaW0oKS50b0xvd2VyQ2FzZSgpID09PSAnL2xvZ2luJykge1xuICAgICAgICAgIHByb21wdCA9ICcnXG4gICAgICAgIH1cblxuICAgICAgICBpZiAob25ib2FyZGluZ1Nob3duKSB7XG4gICAgICAgICAgLy8gUmVmcmVzaCBhdXRoLWRlcGVuZGVudCBzZXJ2aWNlcyBub3cgdGhhdCB0aGUgdXNlciBoYXMgbG9nZ2VkIGluIGR1cmluZyBvbmJvYXJkaW5nLlxuICAgICAgICAgIC8vIEtlZXAgaW4gc3luYyB3aXRoIHRoZSBwb3N0LWxvZ2luIGxvZ2ljIGluIHNyYy9jb21tYW5kcy9sb2dpbi50c3hcbiAgICAgICAgICB2b2lkIHJlZnJlc2hSZW1vdGVNYW5hZ2VkU2V0dGluZ3MoKVxuICAgICAgICAgIHZvaWQgcmVmcmVzaFBvbGljeUxpbWl0cygpXG4gICAgICAgICAgLy8gQ2xlYXIgdXNlciBkYXRhIGNhY2hlIEJFRk9SRSBHcm93dGhCb29rIHJlZnJlc2ggc28gaXQgcGlja3MgdXAgZnJlc2ggY3JlZGVudGlhbHNcbiAgICAgICAgICByZXNldFVzZXJDYWNoZSgpXG4gICAgICAgICAgLy8gUmVmcmVzaCBHcm93dGhCb29rIGFmdGVyIGxvZ2luIHRvIGdldCB1cGRhdGVkIGZlYXR1cmUgZmxhZ3MgKGUuZy4sIGZvciBjbGF1ZGUuYWkgTUNQcylcbiAgICAgICAgICByZWZyZXNoR3Jvd3RoQm9va0FmdGVyQXV0aENoYW5nZSgpXG4gICAgICAgICAgLy8gQ2xlYXIgYW55IHN0YWxlIHRydXN0ZWQgZGV2aWNlIHRva2VuIHRoZW4gZW5yb2xsIGZvciBSZW1vdGUgQ29udHJvbC5cbiAgICAgICAgICAvLyBCb3RoIHNlbGYtZ2F0ZSBvbiB0ZW5ndV9zZXNzaW9uc19lbGV2YXRlZF9hdXRoX2VuZm9yY2VtZW50IGludGVybmFsbHlcbiAgICAgICAgICAvLyBcdTIwMTQgZW5yb2xsVHJ1c3RlZERldmljZSgpIHZpYSBjaGVja0dhdGVfQ0FDSEVEX09SX0JMT0NLSU5HIChhd2FpdHNcbiAgICAgICAgICAvLyB0aGUgR3Jvd3RoQm9vayByZWluaXQgYWJvdmUpLCBjbGVhclRydXN0ZWREZXZpY2VUb2tlbigpIHZpYSB0aGVcbiAgICAgICAgICAvLyBzeW5jIGNhY2hlZCBjaGVjayAoYWNjZXB0YWJsZSBzaW5jZSBjbGVhciBpcyBpZGVtcG90ZW50KS5cbiAgICAgICAgICB2b2lkIGltcG9ydCgnLi9icmlkZ2UvdHJ1c3RlZERldmljZS5qcycpLnRoZW4obSA9PiB7XG4gICAgICAgICAgICBtLmNsZWFyVHJ1c3RlZERldmljZVRva2VuKClcbiAgICAgICAgICAgIHJldHVybiBtLmVucm9sbFRydXN0ZWREZXZpY2UoKVxuICAgICAgICAgIH0pXG4gICAgICAgIH1cblxuICAgICAgICAvLyBWYWxpZGF0ZSB0aGF0IHRoZSBhY3RpdmUgdG9rZW4ncyBvcmcgbWF0Y2hlcyBmb3JjZUxvZ2luT3JnVVVJRCAoaWYgc2V0XG4gICAgICAgIC8vIGluIG1hbmFnZWQgc2V0dGluZ3MpLiBSdW5zIGFmdGVyIG9uYm9hcmRpbmcgc28gbWFuYWdlZCBzZXR0aW5ncyBhbmRcbiAgICAgICAgLy8gbG9naW4gc3RhdGUgYXJlIGZ1bGx5IGxvYWRlZC5cbiAgICAgICAgY29uc3Qgb3JnVmFsaWRhdGlvbiA9IGF3YWl0IHZhbGlkYXRlRm9yY2VMb2dpbk9yZygpXG4gICAgICAgIGlmICghb3JnVmFsaWRhdGlvbi52YWxpZCkge1xuICAgICAgICAgIGF3YWl0IGV4aXRXaXRoRXJyb3Iocm9vdCwgb3JnVmFsaWRhdGlvbi5tZXNzYWdlKVxuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIElmIGdyYWNlZnVsU2h1dGRvd24gd2FzIGluaXRpYXRlZCAoZS5nLiwgdXNlciByZWplY3RlZCB0cnVzdCBkaWFsb2cpLFxuICAgICAgLy8gcHJvY2Vzcy5leGl0Q29kZSB3aWxsIGJlIHNldC4gU2tpcCBhbGwgc3Vic2VxdWVudCBvcGVyYXRpb25zIHRoYXQgY291bGRcbiAgICAgIC8vIHRyaWdnZXIgY29kZSBleGVjdXRpb24gYmVmb3JlIHRoZSBwcm9jZXNzIGV4aXRzIChlLmcuIHdlIGRvbid0IHdhbnQgYXBpS2V5SGVscGVyXG4gICAgICAvLyB0byBydW4gaWYgdHJ1c3Qgd2FzIG5vdCBlc3RhYmxpc2hlZCkuXG4gICAgICBpZiAocHJvY2Vzcy5leGl0Q29kZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAnR3JhY2VmdWwgc2h1dGRvd24gaW5pdGlhdGVkLCBza2lwcGluZyBmdXJ0aGVyIGluaXRpYWxpemF0aW9uJyxcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIH1cblxuICAgICAgLy8gSW5pdGlhbGl6ZSBMU1AgbWFuYWdlciBBRlRFUiB0cnVzdCBpcyBlc3RhYmxpc2hlZCAob3IgaW4gbm9uLWludGVyYWN0aXZlIG1vZGVcbiAgICAgIC8vIHdoZXJlIHRydXN0IGlzIGltcGxpY2l0KS4gVGhpcyBwcmV2ZW50cyBwbHVnaW4gTFNQIHNlcnZlcnMgZnJvbSBleGVjdXRpbmdcbiAgICAgIC8vIGNvZGUgaW4gdW50cnVzdGVkIGRpcmVjdG9yaWVzIGJlZm9yZSB1c2VyIGNvbnNlbnQuXG4gICAgICAvLyBNdXN0IGJlIGFmdGVyIGlubGluZSBwbHVnaW5zIGFyZSBzZXQgKGlmIGFueSkgc28gLS1wbHVnaW4tZGlyIExTUCBzZXJ2ZXJzIGFyZSBpbmNsdWRlZC5cbiAgICAgIGluaXRpYWxpemVMc3BTZXJ2ZXJNYW5hZ2VyKClcblxuICAgICAgLy8gU2hvdyBzZXR0aW5ncyB2YWxpZGF0aW9uIGVycm9ycyBhZnRlciB0cnVzdCBpcyBlc3RhYmxpc2hlZFxuICAgICAgLy8gTUNQIGNvbmZpZyBlcnJvcnMgZG9uJ3QgYmxvY2sgc2V0dGluZ3MgZnJvbSBsb2FkaW5nLCBzbyBleGNsdWRlIHRoZW1cbiAgICAgIGlmICghaXNOb25JbnRlcmFjdGl2ZVNlc3Npb24pIHtcbiAgICAgICAgY29uc3QgeyBlcnJvcnMgfSA9IGdldFNldHRpbmdzV2l0aEVycm9ycygpXG4gICAgICAgIGNvbnN0IG5vbk1jcEVycm9ycyA9IGVycm9ycy5maWx0ZXIoZSA9PiAhZS5tY3BFcnJvck1ldGFkYXRhKVxuICAgICAgICBpZiAobm9uTWNwRXJyb3JzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBhd2FpdCBsYXVuY2hJbnZhbGlkU2V0dGluZ3NEaWFsb2cocm9vdCwge1xuICAgICAgICAgICAgc2V0dGluZ3NFcnJvcnM6IG5vbk1jcEVycm9ycyxcbiAgICAgICAgICAgIG9uRXhpdDogKCkgPT4gZ3JhY2VmdWxTaHV0ZG93blN5bmMoMSksXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBDaGVjayBxdW90YSBzdGF0dXMsIGZhc3QgbW9kZSwgcGFzc2VzIGVsaWdpYmlsaXR5LCBhbmQgYm9vdHN0cmFwIGRhdGFcbiAgICAgIC8vIGFmdGVyIHRydXN0IGlzIGVzdGFibGlzaGVkLiBUaGVzZSBtYWtlIEFQSSBjYWxscyB3aGljaCBjb3VsZCB0cmlnZ2VyXG4gICAgICAvLyBhcGlLZXlIZWxwZXIgZXhlY3V0aW9uLlxuICAgICAgLy8gLS1iYXJlIC8gU0lNUExFOiBza2lwIFx1MjAxNCB0aGVzZSBhcmUgY2FjaGUtd2FybXMgZm9yIHRoZSBSRVBMJ3NcbiAgICAgIC8vIGZpcnN0LXR1cm4gcmVzcG9uc2l2ZW5lc3MgKHF1b3RhLCBwYXNzZXMsIGZhc3RNb2RlLCBib290c3RyYXAgZGF0YSkuIEZhc3RcbiAgICAgIC8vIG1vZGUgZG9lc24ndCBhcHBseSB0byB0aGUgQWdlbnQgU0RLIGFueXdheSAoc2VlIGdldEZhc3RNb2RlVW5hdmFpbGFibGVSZWFzb24pLlxuICAgICAgY29uc3QgYmdSZWZyZXNoVGhyb3R0bGVNcyA9IGdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFKFxuICAgICAgICAndGVuZ3VfY2ljYWRhX25hcF9tcycsXG4gICAgICAgIDAsXG4gICAgICApXG4gICAgICBjb25zdCBsYXN0UHJlZmV0Y2hlZCA9IGdldEdsb2JhbENvbmZpZygpLnN0YXJ0dXBQcmVmZXRjaGVkQXQgPz8gMFxuICAgICAgY29uc3Qgc2tpcFN0YXJ0dXBQcmVmZXRjaGVzID1cbiAgICAgICAgaXNCYXJlTW9kZSgpIHx8XG4gICAgICAgIChiZ1JlZnJlc2hUaHJvdHRsZU1zID4gMCAmJlxuICAgICAgICAgIERhdGUubm93KCkgLSBsYXN0UHJlZmV0Y2hlZCA8IGJnUmVmcmVzaFRocm90dGxlTXMpXG5cbiAgICAgIGlmICghc2tpcFN0YXJ0dXBQcmVmZXRjaGVzKSB7XG4gICAgICAgIGNvbnN0IGxhc3RQcmVmZXRjaGVkSW5mbyA9XG4gICAgICAgICAgbGFzdFByZWZldGNoZWQgPiAwXG4gICAgICAgICAgICA/IGAgbGFzdCByYW4gJHtNYXRoLnJvdW5kKChEYXRlLm5vdygpIC0gbGFzdFByZWZldGNoZWQpIC8gMTAwMCl9cyBhZ29gXG4gICAgICAgICAgICA6ICcnXG4gICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICBgU3RhcnRpbmcgYmFja2dyb3VuZCBzdGFydHVwIHByZWZldGNoZXMke2xhc3RQcmVmZXRjaGVkSW5mb31gLFxuICAgICAgICApXG5cbiAgICAgICAgY2hlY2tRdW90YVN0YXR1cygpLmNhdGNoKGVycm9yID0+IGxvZ0Vycm9yKGVycm9yKSlcblxuICAgICAgICAvLyBGZXRjaCBib290c3RyYXAgZGF0YSBmcm9tIHRoZSBzZXJ2ZXIgYW5kIHVwZGF0ZSBhbGwgY2FjaGUgdmFsdWVzLlxuICAgICAgICB2b2lkIGZldGNoQm9vdHN0cmFwRGF0YSgpXG5cbiAgICAgICAgLy8gVE9ETzogQ29uc29saWRhdGUgb3RoZXIgcHJlZmV0Y2hlcyBpbnRvIGEgc2luZ2xlIGJvb3RzdHJhcCByZXF1ZXN0LlxuICAgICAgICB2b2lkIHByZWZldGNoUGFzc2VzRWxpZ2liaWxpdHkoKVxuICAgICAgICBpZiAoXG4gICAgICAgICAgIWdldEZlYXR1cmVWYWx1ZV9DQUNIRURfTUFZX0JFX1NUQUxFKCd0ZW5ndV9taXJhY3Vsb190aGVfYmFyZCcsIGZhbHNlKVxuICAgICAgICApIHtcbiAgICAgICAgICB2b2lkIHByZWZldGNoRmFzdE1vZGVTdGF0dXMoKVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIEtpbGwgc3dpdGNoIHNraXBzIHRoZSBuZXR3b3JrIGNhbGwsIG5vdCBvcmctcG9saWN5IGVuZm9yY2VtZW50LlxuICAgICAgICAgIC8vIFJlc29sdmUgZnJvbSBjYWNoZSBzbyBvcmdTdGF0dXMgZG9lc24ndCBzdGF5ICdwZW5kaW5nJyAod2hpY2hcbiAgICAgICAgICAvLyBnZXRGYXN0TW9kZVVuYXZhaWxhYmxlUmVhc29uIHRyZWF0cyBhcyBwZXJtaXNzaXZlKS5cbiAgICAgICAgICByZXNvbHZlRmFzdE1vZGVTdGF0dXNGcm9tQ2FjaGUoKVxuICAgICAgICB9XG4gICAgICAgIGlmIChiZ1JlZnJlc2hUaHJvdHRsZU1zID4gMCkge1xuICAgICAgICAgIHNhdmVHbG9iYWxDb25maWcoY3VycmVudCA9PiAoe1xuICAgICAgICAgICAgLi4uY3VycmVudCxcbiAgICAgICAgICAgIHN0YXJ0dXBQcmVmZXRjaGVkQXQ6IERhdGUubm93KCksXG4gICAgICAgICAgfSkpXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICBgU2tpcHBpbmcgc3RhcnR1cCBwcmVmZXRjaGVzLCBsYXN0IHJhbiAke01hdGgucm91bmQoKERhdGUubm93KCkgLSBsYXN0UHJlZmV0Y2hlZCkgLyAxMDAwKX1zIGFnb2AsXG4gICAgICAgIClcbiAgICAgICAgLy8gUmVzb2x2ZSBmYXN0IG1vZGUgb3JnIHN0YXR1cyBmcm9tIGNhY2hlIChubyBuZXR3b3JrKVxuICAgICAgICByZXNvbHZlRmFzdE1vZGVTdGF0dXNGcm9tQ2FjaGUoKVxuICAgICAgfVxuXG4gICAgICBpZiAoIWlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgIHZvaWQgcmVmcmVzaEV4YW1wbGVDb21tYW5kcygpIC8vIFByZS1mZXRjaCBleGFtcGxlIGNvbW1hbmRzIChydW5zIGdpdCBsb2csIG5vIEFQSSBjYWxsKVxuICAgICAgfVxuXG4gICAgICAvLyBSZXNvbHZlIE1DUCBjb25maWdzIChzdGFydGVkIGVhcmx5LCBvdmVybGFwcyB3aXRoIHNldHVwL3RydXN0IGRpYWxvZyB3b3JrKVxuICAgICAgY29uc3QgeyBzZXJ2ZXJzOiBleGlzdGluZ01jcENvbmZpZ3MgfSA9IGF3YWl0IG1jcENvbmZpZ1Byb21pc2VcbiAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgYFtTVEFSVFVQXSBNQ1AgY29uZmlncyByZXNvbHZlZCBpbiAke21jcENvbmZpZ1Jlc29sdmVkTXN9bXMgKGF3YWl0ZWQgYXQgKyR7RGF0ZS5ub3coKSAtIG1jcENvbmZpZ1N0YXJ0fW1zKWAsXG4gICAgICApXG4gICAgICAvLyBDTEkgZmxhZyAoLS1tY3AtY29uZmlnKSBzaG91bGQgb3ZlcnJpZGUgZmlsZS1iYXNlZCBjb25maWdzLCBtYXRjaGluZyBzZXR0aW5ncyBwcmVjZWRlbmNlXG4gICAgICBjb25zdCBhbGxNY3BDb25maWdzID0geyAuLi5leGlzdGluZ01jcENvbmZpZ3MsIC4uLmR5bmFtaWNNY3BDb25maWcgfVxuXG4gICAgICAvLyBTZXBhcmF0ZSBTREsgY29uZmlncyBmcm9tIHJlZ3VsYXIgTUNQIGNvbmZpZ3NcbiAgICAgIGNvbnN0IHNka01jcENvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIE1jcFNka1NlcnZlckNvbmZpZz4gPSB7fVxuICAgICAgY29uc3QgcmVndWxhck1jcENvbmZpZ3M6IFJlY29yZDxzdHJpbmcsIFNjb3BlZE1jcFNlcnZlckNvbmZpZz4gPSB7fVxuXG4gICAgICBmb3IgKGNvbnN0IFtuYW1lLCBjb25maWddIG9mIE9iamVjdC5lbnRyaWVzKGFsbE1jcENvbmZpZ3MpKSB7XG4gICAgICAgIGNvbnN0IHR5cGVkQ29uZmlnID0gY29uZmlnIGFzIFNjb3BlZE1jcFNlcnZlckNvbmZpZyB8IE1jcFNka1NlcnZlckNvbmZpZ1xuICAgICAgICBpZiAodHlwZWRDb25maWcudHlwZSA9PT0gJ3NkaycpIHtcbiAgICAgICAgICBzZGtNY3BDb25maWdzW25hbWVdID0gdHlwZWRDb25maWcgYXMgTWNwU2RrU2VydmVyQ29uZmlnXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcmVndWxhck1jcENvbmZpZ3NbbmFtZV0gPSB0eXBlZENvbmZpZyBhcyBTY29wZWRNY3BTZXJ2ZXJDb25maWdcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX21jcF9jb25maWdzX2xvYWRlZCcpXG5cbiAgICAgIC8vIFByZWZldGNoIE1DUCByZXNvdXJjZXMgYWZ0ZXIgdHJ1c3QgZGlhbG9nICh0aGlzIGlzIHdoZXJlIGV4ZWN1dGlvbiBoYXBwZW5zKS5cbiAgICAgIC8vIEludGVyYWN0aXZlIG1vZGUgb25seTogcHJpbnQgbW9kZSBkZWZlcnMgY29ubmVjdHMgdW50aWwgaGVhZGxlc3NTdG9yZSBleGlzdHNcbiAgICAgIC8vIGFuZCBwdXNoZXMgcGVyLXNlcnZlciAoYmVsb3cpLCBzbyBUb29sU2VhcmNoJ3MgcGVuZGluZy1jbGllbnQgaGFuZGxpbmcgd29ya3NcbiAgICAgIC8vIGFuZCBvbmUgc2xvdyBzZXJ2ZXIgZG9lc24ndCBibG9jayB0aGUgYmF0Y2guXG4gICAgICBjb25zdCBsb2NhbE1jcFByb21pc2UgPSBpc05vbkludGVyYWN0aXZlU2Vzc2lvblxuICAgICAgICA/IFByb21pc2UucmVzb2x2ZSh7IGNsaWVudHM6IFtdLCB0b29sczogW10sIGNvbW1hbmRzOiBbXSB9KVxuICAgICAgICA6IHByZWZldGNoQWxsTWNwUmVzb3VyY2VzKHJlZ3VsYXJNY3BDb25maWdzKVxuICAgICAgY29uc3QgY2xhdWRlYWlNY3BQcm9taXNlID0gaXNOb25JbnRlcmFjdGl2ZVNlc3Npb25cbiAgICAgICAgPyBQcm9taXNlLnJlc29sdmUoeyBjbGllbnRzOiBbXSwgdG9vbHM6IFtdLCBjb21tYW5kczogW10gfSlcbiAgICAgICAgOiBjbGF1ZGVhaUNvbmZpZ1Byb21pc2UudGhlbihjb25maWdzID0+XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhjb25maWdzKS5sZW5ndGggPiAwXG4gICAgICAgICAgICAgID8gcHJlZmV0Y2hBbGxNY3BSZXNvdXJjZXMoY29uZmlncylcbiAgICAgICAgICAgICAgOiB7IGNsaWVudHM6IFtdLCB0b29sczogW10sIGNvbW1hbmRzOiBbXSB9LFxuICAgICAgICAgIClcbiAgICAgIC8vIE1lcmdlIHdpdGggZGVkdXAgYnkgbmFtZTogZWFjaCBwcmVmZXRjaEFsbE1jcFJlc291cmNlcyBjYWxsIGluZGVwZW5kZW50bHlcbiAgICAgIC8vIGFkZHMgaGVscGVyIHRvb2xzIChMaXN0TWNwUmVzb3VyY2VzVG9vbCwgUmVhZE1jcFJlc291cmNlVG9vbCkgdmlhXG4gICAgICAvLyBsb2NhbCBkZWR1cCBmbGFncywgc28gbWVyZ2luZyB0d28gY2FsbHMgY2FuIHlpZWxkIGR1cGxpY2F0ZXMuIHByaW50LnRzXG4gICAgICAvLyBhbHJlYWR5IHVuaXFCeSdzIHRoZSBmaW5hbCB0b29sIHBvb2wsIGJ1dCBkZWR1cCBoZXJlIGtlZXBzIGFwcFN0YXRlIGNsZWFuLlxuICAgICAgY29uc3QgbWNwUHJvbWlzZSA9IFByb21pc2UuYWxsKFtcbiAgICAgICAgbG9jYWxNY3BQcm9taXNlLFxuICAgICAgICBjbGF1ZGVhaU1jcFByb21pc2UsXG4gICAgICBdKS50aGVuKChbbG9jYWwsIGNsYXVkZWFpXSkgPT4gKHtcbiAgICAgICAgY2xpZW50czogWy4uLmxvY2FsLmNsaWVudHMsIC4uLmNsYXVkZWFpLmNsaWVudHNdLFxuICAgICAgICB0b29sczogdW5pcUJ5KFsuLi5sb2NhbC50b29scywgLi4uY2xhdWRlYWkudG9vbHNdLCAnbmFtZScpLFxuICAgICAgICBjb21tYW5kczogdW5pcUJ5KFsuLi5sb2NhbC5jb21tYW5kcywgLi4uY2xhdWRlYWkuY29tbWFuZHNdLCAnbmFtZScpLFxuICAgICAgfSkpXG5cbiAgICAgIC8vIFN0YXJ0IGhvb2tzIGVhcmx5IHNvIHRoZXkgcnVuIGluIHBhcmFsbGVsIHdpdGggTUNQIGNvbm5lY3Rpb25zLlxuICAgICAgLy8gU2tpcCBmb3IgaW5pdE9ubHkvaW5pdC9tYWludGVuYW5jZSAoaGFuZGxlZCBzZXBhcmF0ZWx5KSwgbm9uLWludGVyYWN0aXZlXG4gICAgICAvLyAoaGFuZGxlZCB2aWEgc2V0dXBUcmlnZ2VyKSwgYW5kIHJlc3VtZS9jb250aW51ZSAoY29udmVyc2F0aW9uUmVjb3ZlcnkudHNcbiAgICAgIC8vIGZpcmVzICdyZXN1bWUnIGluc3RlYWQgXHUyMDE0IHdpdGhvdXQgdGhpcyBndWFyZCwgaG9va3MgZmlyZSBUV0lDRSBvbiAvcmVzdW1lXG4gICAgICAvLyBhbmQgdGhlIHNlY29uZCBzeXN0ZW1NZXNzYWdlIGNsb2JiZXJzIHRoZSBmaXJzdC4gZ2gtMzA4MjUpXG4gICAgICBjb25zdCBob29rc1Byb21pc2UgPVxuICAgICAgICBpbml0T25seSB8fFxuICAgICAgICBpbml0IHx8XG4gICAgICAgIG1haW50ZW5hbmNlIHx8XG4gICAgICAgIGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uIHx8XG4gICAgICAgIG9wdGlvbnMuY29udGludWUgfHxcbiAgICAgICAgb3B0aW9ucy5yZXN1bWVcbiAgICAgICAgICA/IG51bGxcbiAgICAgICAgICA6IHByb2Nlc3NTZXNzaW9uU3RhcnRIb29rcygnc3RhcnR1cCcsIHtcbiAgICAgICAgICAgICAgYWdlbnRUeXBlOiBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uPy5hZ2VudFR5cGUsXG4gICAgICAgICAgICAgIG1vZGVsOiByZXNvbHZlZEluaXRpYWxNb2RlbCxcbiAgICAgICAgICAgIH0pXG5cbiAgICAgIC8vIE1DUCBuZXZlciBibG9ja3MgUkVQTCByZW5kZXIgT1IgdHVybiAxIFRURlQuIHVzZU1hbmFnZU1DUENvbm5lY3Rpb25zXG4gICAgICAvLyBwb3B1bGF0ZXMgYXBwU3RhdGUubWNwIGFzeW5jIGFzIHNlcnZlcnMgY29ubmVjdCAoY29ubmVjdFRvU2VydmVyIGlzXG4gICAgICAvLyBtZW1vaXplZCBcdTIwMTQgdGhlIHByZWZldGNoIGNhbGxzIGFib3ZlIGFuZCB0aGUgaG9vayBjb252ZXJnZSBvbiB0aGUgc2FtZVxuICAgICAgLy8gY29ubmVjdGlvbnMpLiBnZXRUb29sVXNlQ29udGV4dCByZWFkcyBzdG9yZS5nZXRTdGF0ZSgpIGZyZXNoIHZpYVxuICAgICAgLy8gY29tcHV0ZVRvb2xzKCksIHNvIHR1cm4gMSBzZWVzIHdoYXRldmVyJ3MgY29ubmVjdGVkIGJ5IHF1ZXJ5IHRpbWUuXG4gICAgICAvLyBTbG93IHNlcnZlcnMgcG9wdWxhdGUgZm9yIHR1cm4gMisuIE1hdGNoZXMgaW50ZXJhY3RpdmUtbm8tcHJvbXB0XG4gICAgICAvLyBiZWhhdmlvci4gUHJpbnQgbW9kZTogcGVyLXNlcnZlciBwdXNoIGludG8gaGVhZGxlc3NTdG9yZSAoYmVsb3cpLlxuICAgICAgY29uc3QgaG9va01lc3NhZ2VzOiBBd2FpdGVkPE5vbk51bGxhYmxlPHR5cGVvZiBob29rc1Byb21pc2U+PiA9IFtdXG4gICAgICAvLyBTdXBwcmVzcyB0cmFuc2llbnQgdW5oYW5kbGVkUmVqZWN0aW9uIFx1MjAxNCB0aGUgcHJlZmV0Y2ggd2FybXMgdGhlXG4gICAgICAvLyBtZW1vaXplZCBjb25uZWN0VG9TZXJ2ZXIgY2FjaGUgYnV0IG5vYm9keSBhd2FpdHMgaXQgaW4gaW50ZXJhY3RpdmUuXG4gICAgICBtY3BQcm9taXNlLmNhdGNoKCgpID0+IHt9KVxuXG4gICAgICBjb25zdCBtY3BDbGllbnRzOiBBd2FpdGVkPHR5cGVvZiBtY3BQcm9taXNlPlsnY2xpZW50cyddID0gW11cbiAgICAgIGNvbnN0IG1jcFRvb2xzOiBBd2FpdGVkPHR5cGVvZiBtY3BQcm9taXNlPlsndG9vbHMnXSA9IFtdXG4gICAgICBjb25zdCBtY3BDb21tYW5kczogQXdhaXRlZDx0eXBlb2YgbWNwUHJvbWlzZT5bJ2NvbW1hbmRzJ10gPSBbXVxuXG4gICAgICBsZXQgdGhpbmtpbmdFbmFibGVkID0gc2hvdWxkRW5hYmxlVGhpbmtpbmdCeURlZmF1bHQoKVxuICAgICAgbGV0IHRoaW5raW5nQ29uZmlnOiBUaGlua2luZ0NvbmZpZyA9XG4gICAgICAgIHRoaW5raW5nRW5hYmxlZCAhPT0gZmFsc2UgPyB7IHR5cGU6ICdhZGFwdGl2ZScgfSA6IHsgdHlwZTogJ2Rpc2FibGVkJyB9XG5cbiAgICAgIGlmIChvcHRpb25zLnRoaW5raW5nID09PSAnYWRhcHRpdmUnIHx8IG9wdGlvbnMudGhpbmtpbmcgPT09ICdlbmFibGVkJykge1xuICAgICAgICB0aGlua2luZ0VuYWJsZWQgPSB0cnVlXG4gICAgICAgIHRoaW5raW5nQ29uZmlnID0geyB0eXBlOiAnYWRhcHRpdmUnIH1cbiAgICAgIH0gZWxzZSBpZiAob3B0aW9ucy50aGlua2luZyA9PT0gJ2Rpc2FibGVkJykge1xuICAgICAgICB0aGlua2luZ0VuYWJsZWQgPSBmYWxzZVxuICAgICAgICB0aGlua2luZ0NvbmZpZyA9IHsgdHlwZTogJ2Rpc2FibGVkJyB9XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCBtYXhUaGlua2luZ1Rva2VucyA9IHByb2Nlc3MuZW52Lk1BWF9USElOS0lOR19UT0tFTlNcbiAgICAgICAgICA/IHBhcnNlSW50KHByb2Nlc3MuZW52Lk1BWF9USElOS0lOR19UT0tFTlMsIDEwKVxuICAgICAgICAgIDogb3B0aW9ucy5tYXhUaGlua2luZ1Rva2Vuc1xuICAgICAgICBpZiAobWF4VGhpbmtpbmdUb2tlbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGlmIChtYXhUaGlua2luZ1Rva2VucyA+IDApIHtcbiAgICAgICAgICAgIHRoaW5raW5nRW5hYmxlZCA9IHRydWVcbiAgICAgICAgICAgIHRoaW5raW5nQ29uZmlnID0ge1xuICAgICAgICAgICAgICB0eXBlOiAnZW5hYmxlZCcsXG4gICAgICAgICAgICAgIGJ1ZGdldFRva2VuczogbWF4VGhpbmtpbmdUb2tlbnMsXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBlbHNlIGlmIChtYXhUaGlua2luZ1Rva2VucyA9PT0gMCkge1xuICAgICAgICAgICAgdGhpbmtpbmdFbmFibGVkID0gZmFsc2VcbiAgICAgICAgICAgIHRoaW5raW5nQ29uZmlnID0geyB0eXBlOiAnZGlzYWJsZWQnIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgbG9nRm9yRGlhZ25vc3RpY3NOb1BJSSgnaW5mbycsICdzdGFydGVkJywge1xuICAgICAgICB2ZXJzaW9uOiBNQUNSTy5WRVJTSU9OLFxuICAgICAgICBpc19uYXRpdmVfYmluYXJ5OiBpc0luQnVuZGxlZE1vZGUoKSxcbiAgICAgIH0pXG5cbiAgICAgIHJlZ2lzdGVyQ2xlYW51cChhc3luYyAoKSA9PiB7XG4gICAgICAgIGxvZ0ZvckRpYWdub3N0aWNzTm9QSUkoJ2luZm8nLCAnZXhpdGVkJylcbiAgICAgIH0pXG5cbiAgICAgIHZvaWQgbG9nVGVuZ3VJbml0KHtcbiAgICAgICAgaGFzSW5pdGlhbFByb21wdDogQm9vbGVhbihwcm9tcHQpLFxuICAgICAgICBoYXNTdGRpbjogQm9vbGVhbihpbnB1dFByb21wdCksXG4gICAgICAgIHZlcmJvc2UsXG4gICAgICAgIGRlYnVnLFxuICAgICAgICBkZWJ1Z1RvU3RkZXJyLFxuICAgICAgICBwcmludDogcHJpbnQgPz8gZmFsc2UsXG4gICAgICAgIG91dHB1dEZvcm1hdDogb3V0cHV0Rm9ybWF0ID8/ICd0ZXh0JyxcbiAgICAgICAgaW5wdXRGb3JtYXQ6IGlucHV0Rm9ybWF0ID8/ICd0ZXh0JyxcbiAgICAgICAgbnVtQWxsb3dlZFRvb2xzOiBhbGxvd2VkVG9vbHMubGVuZ3RoLFxuICAgICAgICBudW1EaXNhbGxvd2VkVG9vbHM6IGRpc2FsbG93ZWRUb29scy5sZW5ndGgsXG4gICAgICAgIG1jcENsaWVudENvdW50OiBPYmplY3Qua2V5cyhhbGxNY3BDb25maWdzKS5sZW5ndGgsXG4gICAgICAgIHdvcmt0cmVlRW5hYmxlZCxcbiAgICAgICAgc2tpcFdlYkZldGNoUHJlZmxpZ2h0OiBnZXRJbml0aWFsU2V0dGluZ3MoKS5za2lwV2ViRmV0Y2hQcmVmbGlnaHQsXG4gICAgICAgIGdpdGh1YkFjdGlvbklucHV0czogcHJvY2Vzcy5lbnYuR0lUSFVCX0FDVElPTl9JTlBVVFMsXG4gICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkOiBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyA/PyBmYWxzZSxcbiAgICAgICAgcGVybWlzc2lvbk1vZGUsXG4gICAgICAgIG1vZGVJc0J5cGFzczogcGVybWlzc2lvbk1vZGUgPT09ICdieXBhc3NQZXJtaXNzaW9ucycsXG4gICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNQYXNzZWQ6IGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgIHN5c3RlbVByb21wdEZsYWc6IHN5c3RlbVByb21wdFxuICAgICAgICAgID8gb3B0aW9ucy5zeXN0ZW1Qcm9tcHRGaWxlXG4gICAgICAgICAgICA/ICdmaWxlJ1xuICAgICAgICAgICAgOiAnZmxhZydcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0RmxhZzogYXBwZW5kU3lzdGVtUHJvbXB0XG4gICAgICAgICAgPyBvcHRpb25zLmFwcGVuZFN5c3RlbVByb21wdEZpbGVcbiAgICAgICAgICAgID8gJ2ZpbGUnXG4gICAgICAgICAgICA6ICdmbGFnJ1xuICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICB0aGlua2luZ0NvbmZpZyxcbiAgICAgICAgYXNzaXN0YW50QWN0aXZhdGlvblBhdGg6XG4gICAgICAgICAgZmVhdHVyZSgnS0FJUk9TJykgJiYga2Fpcm9zRW5hYmxlZFxuICAgICAgICAgICAgPyBhc3Npc3RhbnRNb2R1bGU/LmdldEFzc2lzdGFudEFjdGl2YXRpb25QYXRoKClcbiAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgfSlcblxuICAgICAgLy8gTG9nIGNvbnRleHQgbWV0cmljcyBvbmNlIGF0IGluaXRpYWxpemF0aW9uXG4gICAgICB2b2lkIGxvZ0NvbnRleHRNZXRyaWNzKHJlZ3VsYXJNY3BDb25maWdzLCB0b29sUGVybWlzc2lvbkNvbnRleHQpXG5cbiAgICAgIHZvaWQgbG9nUGVybWlzc2lvbkNvbnRleHRGb3JBbnRzKG51bGwsICdpbml0aWFsaXphdGlvbicpXG5cbiAgICAgIGxvZ01hbmFnZWRTZXR0aW5ncygpXG5cbiAgICAgIC8vIFJlZ2lzdGVyIFBJRCBmaWxlIGZvciBjb25jdXJyZW50LXNlc3Npb24gZGV0ZWN0aW9uICh+Ly5jbGF1ZGUvc2Vzc2lvbnMvKVxuICAgICAgLy8gYW5kIGZpcmUgbXVsdGktY2xhdWRpbmcgdGVsZW1ldHJ5LiBMaXZlcyBoZXJlIChub3QgaW5pdC50cykgc28gb25seSB0aGVcbiAgICAgIC8vIFJFUEwgcGF0aCByZWdpc3RlcnMgXHUyMDE0IG5vdCBzdWJjb21tYW5kcyBsaWtlIGBjbGF1ZGUgZG9jdG9yYC4gQ2hhaW5lZDpcbiAgICAgIC8vIGNvdW50IG11c3QgcnVuIGFmdGVyIHJlZ2lzdGVyJ3Mgd3JpdGUgY29tcGxldGVzIG9yIGl0IG1pc3NlcyBvdXIgb3duIGZpbGUuXG4gICAgICB2b2lkIHJlZ2lzdGVyU2Vzc2lvbigpLnRoZW4ocmVnaXN0ZXJlZCA9PiB7XG4gICAgICAgIGlmICghcmVnaXN0ZXJlZCkgcmV0dXJuXG4gICAgICAgIGlmIChzZXNzaW9uTmFtZUFyZykge1xuICAgICAgICAgIHZvaWQgdXBkYXRlU2Vzc2lvbk5hbWUoc2Vzc2lvbk5hbWVBcmcpXG4gICAgICAgIH1cbiAgICAgICAgdm9pZCBjb3VudENvbmN1cnJlbnRTZXNzaW9ucygpLnRoZW4oY291bnQgPT4ge1xuICAgICAgICAgIGlmIChjb3VudCA+PSAyKSB7XG4gICAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY29uY3VycmVudF9zZXNzaW9ucycsIHsgbnVtX3Nlc3Npb25zOiBjb3VudCB9KVxuICAgICAgICAgIH1cbiAgICAgICAgfSlcbiAgICAgIH0pXG5cbiAgICAgIC8vIEluaXRpYWxpemUgdmVyc2lvbmVkIHBsdWdpbnMgc3lzdGVtICh0cmlnZ2VycyBWMVx1MjE5MlYyIG1pZ3JhdGlvbiBpZlxuICAgICAgLy8gbmVlZGVkKS4gVGhlbiBydW4gb3JwaGFuIEdDLCBUSEVOIHdhcm0gdGhlIEdyZXAvR2xvYiBleGNsdXNpb24gY2FjaGUuXG4gICAgICAvLyBTZXF1ZW5jaW5nIG1hdHRlcnM6IHRoZSB3YXJtdXAgc2NhbnMgZGlzayBmb3IgLm9ycGhhbmVkX2F0IG1hcmtlcnMsXG4gICAgICAvLyBzbyBpdCBtdXN0IHNlZSB0aGUgR0MncyBQYXNzIDEgKHJlbW92ZSBtYXJrZXJzIGZyb20gcmVpbnN0YWxsZWRcbiAgICAgIC8vIHZlcnNpb25zKSBhbmQgUGFzcyAyIChzdGFtcCB1bm1hcmtlZCBvcnBoYW5zKSBhbHJlYWR5IGFwcGxpZWQuIFRoZVxuICAgICAgLy8gd2FybSBhbHNvIGxhbmRzIGJlZm9yZSBhdXRvdXBkYXRlIChmaXJlcyBvbiBmaXJzdCBzdWJtaXQgaW4gUkVQTClcbiAgICAgIC8vIGNhbiBvcnBoYW4gdGhpcyBzZXNzaW9uJ3MgYWN0aXZlIHZlcnNpb24gdW5kZXJuZWF0aCB1cy5cbiAgICAgIC8vIC0tYmFyZSAvIFNJTVBMRTogc2tpcCBwbHVnaW4gdmVyc2lvbiBzeW5jICsgb3JwaGFuIGNsZWFudXAuIFRoZXNlXG4gICAgICAvLyBhcmUgaW5zdGFsbC91cGdyYWRlIGJvb2trZWVwaW5nIHRoYXQgc2NyaXB0ZWQgY2FsbHMgZG9uJ3QgbmVlZCBcdTIwMTRcbiAgICAgIC8vIHRoZSBuZXh0IGludGVyYWN0aXZlIHNlc3Npb24gd2lsbCByZWNvbmNpbGUuIFRoZSBhd2FpdCBoZXJlIHdhc1xuICAgICAgLy8gYmxvY2tpbmcgLXAgb24gYSBtYXJrZXRwbGFjZSByb3VuZC10cmlwLlxuICAgICAgaWYgKGlzQmFyZU1vZGUoKSkge1xuICAgICAgICAvLyBza2lwIFx1MjAxNCBuby1vcFxuICAgICAgfSBlbHNlIGlmIChpc05vbkludGVyYWN0aXZlU2Vzc2lvbikge1xuICAgICAgICAvLyBJbiBoZWFkbGVzcyBtb2RlLCBhd2FpdCB0byBlbnN1cmUgcGx1Z2luIHN5bmMgY29tcGxldGVzIGJlZm9yZSBDTEkgZXhpdHNcbiAgICAgICAgYXdhaXQgaW5pdGlhbGl6ZVZlcnNpb25lZFBsdWdpbnMoKVxuICAgICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2FmdGVyX3BsdWdpbnNfaW5pdCcpXG4gICAgICAgIHZvaWQgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQoKS50aGVuKCgpID0+XG4gICAgICAgICAgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSgpLFxuICAgICAgICApXG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBJbiBpbnRlcmFjdGl2ZSBtb2RlLCBmaXJlLWFuZC1mb3JnZXQgXHUyMDE0IHRoaXMgaXMgcHVyZWx5IGJvb2trZWVwaW5nXG4gICAgICAgIC8vIHRoYXQgZG9lc24ndCBhZmZlY3QgcnVudGltZSBiZWhhdmlvciBvZiB0aGUgY3VycmVudCBzZXNzaW9uXG4gICAgICAgIHZvaWQgaW5pdGlhbGl6ZVZlcnNpb25lZFBsdWdpbnMoKS50aGVuKGFzeW5jICgpID0+IHtcbiAgICAgICAgICBwcm9maWxlQ2hlY2twb2ludCgnYWN0aW9uX2FmdGVyX3BsdWdpbnNfaW5pdCcpXG4gICAgICAgICAgYXdhaXQgY2xlYW51cE9ycGhhbmVkUGx1Z2luVmVyc2lvbnNJbkJhY2tncm91bmQoKVxuICAgICAgICAgIHZvaWQgZ2V0R2xvYkV4Y2x1c2lvbnNGb3JQbHVnaW5DYWNoZSgpXG4gICAgICAgIH0pXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNldHVwVHJpZ2dlciA9XG4gICAgICAgIGluaXRPbmx5IHx8IGluaXQgPyAnaW5pdCcgOiBtYWludGVuYW5jZSA/ICdtYWludGVuYW5jZScgOiBudWxsXG4gICAgICBpZiAoaW5pdE9ubHkpIHtcbiAgICAgICAgYXBwbHlDb25maWdFbnZpcm9ubWVudFZhcmlhYmxlcygpXG4gICAgICAgIGF3YWl0IHByb2Nlc3NTZXR1cEhvb2tzKCdpbml0JywgeyBmb3JjZVN5bmNFeGVjdXRpb246IHRydWUgfSlcbiAgICAgICAgYXdhaXQgcHJvY2Vzc1Nlc3Npb25TdGFydEhvb2tzKCdzdGFydHVwJywgeyBmb3JjZVN5bmNFeGVjdXRpb246IHRydWUgfSlcbiAgICAgICAgZ3JhY2VmdWxTaHV0ZG93blN5bmMoMClcbiAgICAgICAgcmV0dXJuXG4gICAgICB9XG5cbiAgICAgIC8vIC0tcHJpbnQgbW9kZVxuICAgICAgaWYgKGlzTm9uSW50ZXJhY3RpdmVTZXNzaW9uKSB7XG4gICAgICAgIGlmIChvdXRwdXRGb3JtYXQgPT09ICdzdHJlYW0tanNvbicgfHwgb3V0cHV0Rm9ybWF0ID09PSAnanNvbicpIHtcbiAgICAgICAgICBzZXRIYXNGb3JtYXR0ZWRPdXRwdXQodHJ1ZSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEFwcGx5IGZ1bGwgZW52aXJvbm1lbnQgdmFyaWFibGVzIGluIHByaW50IG1vZGUgc2luY2UgdHJ1c3QgZGlhbG9nIGlzIGJ5cGFzc2VkXG4gICAgICAgIC8vIFRoaXMgaW5jbHVkZXMgcG90ZW50aWFsbHkgZGFuZ2Vyb3VzIGVudmlyb25tZW50IHZhcmlhYmxlcyBmcm9tIHVudHJ1c3RlZCBzb3VyY2VzXG4gICAgICAgIC8vIGJ1dCBwcmludCBtb2RlIGlzIGNvbnNpZGVyZWQgdHJ1c3RlZCAoYXMgZG9jdW1lbnRlZCBpbiBoZWxwIHRleHQpXG4gICAgICAgIGFwcGx5Q29uZmlnRW52aXJvbm1lbnRWYXJpYWJsZXMoKVxuXG4gICAgICAgIC8vIEluaXRpYWxpemUgdGVsZW1ldHJ5IGFmdGVyIGVudiB2YXJzIGFyZSBhcHBsaWVkIHNvIE9URUwgZW5kcG9pbnQgZW52IHZhcnMgYW5kXG4gICAgICAgIC8vIG90ZWxIZWFkZXJzSGVscGVyICh3aGljaCByZXF1aXJlcyB0cnVzdCB0byBleGVjdXRlKSBhcmUgYXZhaWxhYmxlLlxuICAgICAgICBpbml0aWFsaXplVGVsZW1ldHJ5QWZ0ZXJUcnVzdCgpXG5cbiAgICAgICAgLy8gS2ljayBTZXNzaW9uU3RhcnQgaG9va3Mgbm93IHNvIHRoZSBzdWJwcm9jZXNzIHNwYXduIG92ZXJsYXBzIHdpdGhcbiAgICAgICAgLy8gTUNQIGNvbm5lY3QgKyBwbHVnaW4gaW5pdCArIHByaW50LnRzIGltcG9ydCBiZWxvdy4gbG9hZEluaXRpYWxNZXNzYWdlc1xuICAgICAgICAvLyBqb2lucyB0aGlzIGF0IHByaW50LnRzOjQzOTcuIEd1YXJkZWQgc2FtZSBhcyBsb2FkSW5pdGlhbE1lc3NhZ2VzIFx1MjAxNFxuICAgICAgICAvLyBjb250aW51ZS9yZXN1bWUvdGVsZXBvcnQgcGF0aHMgZG9uJ3QgZmlyZSBzdGFydHVwIGhvb2tzIChvciBmaXJlIHRoZW1cbiAgICAgICAgLy8gY29uZGl0aW9uYWxseSBpbnNpZGUgdGhlIHJlc3VtZSBicmFuY2gsIHdoZXJlIHRoaXMgcHJvbWlzZSBpc1xuICAgICAgICAvLyB1bmRlZmluZWQgYW5kIHRoZSA/PyBmYWxsYmFjayBydW5zKS4gQWxzbyBza2lwIHdoZW4gc2V0dXBUcmlnZ2VyIGlzXG4gICAgICAgIC8vIHNldCBcdTIwMTQgdGhvc2UgcGF0aHMgcnVuIHNldHVwIGhvb2tzIGZpcnN0IChwcmludC50czo1NDQpLCBhbmQgc2Vzc2lvblxuICAgICAgICAvLyBzdGFydCBob29rcyBtdXN0IHdhaXQgdW50aWwgc2V0dXAgY29tcGxldGVzLlxuICAgICAgICBjb25zdCBzZXNzaW9uU3RhcnRIb29rc1Byb21pc2UgPVxuICAgICAgICAgIG9wdGlvbnMuY29udGludWUgfHwgb3B0aW9ucy5yZXN1bWUgfHwgdGVsZXBvcnQgfHwgc2V0dXBUcmlnZ2VyXG4gICAgICAgICAgICA/IHVuZGVmaW5lZFxuICAgICAgICAgICAgOiBwcm9jZXNzU2Vzc2lvblN0YXJ0SG9va3MoJ3N0YXJ0dXAnKVxuICAgICAgICAvLyBTdXBwcmVzcyB0cmFuc2llbnQgdW5oYW5kbGVkUmVqZWN0aW9uIGlmIHRoaXMgcmVqZWN0cyBiZWZvcmVcbiAgICAgICAgLy8gbG9hZEluaXRpYWxNZXNzYWdlcyBhd2FpdHMgaXQuIERvd25zdHJlYW0gYXdhaXQgc3RpbGwgb2JzZXJ2ZXMgdGhlXG4gICAgICAgIC8vIHJlamVjdGlvbiBcdTIwMTQgdGhpcyBqdXN0IHByZXZlbnRzIHRoZSBzcHVyaW91cyBnbG9iYWwgaGFuZGxlciBmaXJlLlxuICAgICAgICBzZXNzaW9uU3RhcnRIb29rc1Byb21pc2U/LmNhdGNoKCgpID0+IHt9KVxuXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdiZWZvcmVfdmFsaWRhdGVGb3JjZUxvZ2luT3JnJylcbiAgICAgICAgLy8gVmFsaWRhdGUgb3JnIHJlc3RyaWN0aW9uIGZvciBub24taW50ZXJhY3RpdmUgc2Vzc2lvbnNcbiAgICAgICAgY29uc3Qgb3JnVmFsaWRhdGlvbiA9IGF3YWl0IHZhbGlkYXRlRm9yY2VMb2dpbk9yZygpXG4gICAgICAgIGlmICghb3JnVmFsaWRhdGlvbi52YWxpZCkge1xuICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKG9yZ1ZhbGlkYXRpb24ubWVzc2FnZSArICdcXG4nKVxuICAgICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSGVhZGxlc3MgbW9kZSBzdXBwb3J0cyBhbGwgcHJvbXB0IGNvbW1hbmRzIGFuZCBzb21lIGxvY2FsIGNvbW1hbmRzXG4gICAgICAgIC8vIElmIGRpc2FibGVTbGFzaENvbW1hbmRzIGlzIHRydWUsIHJldHVybiBlbXB0eSBhcnJheVxuICAgICAgICBjb25zdCBjb21tYW5kc0hlYWRsZXNzID0gZGlzYWJsZVNsYXNoQ29tbWFuZHNcbiAgICAgICAgICA/IFtdXG4gICAgICAgICAgOiBjb21tYW5kcy5maWx0ZXIoXG4gICAgICAgICAgICAgIGNvbW1hbmQgPT5cbiAgICAgICAgICAgICAgICAoY29tbWFuZC50eXBlID09PSAncHJvbXB0JyAmJiAhY29tbWFuZC5kaXNhYmxlTm9uSW50ZXJhY3RpdmUpIHx8XG4gICAgICAgICAgICAgICAgKGNvbW1hbmQudHlwZSA9PT0gJ2xvY2FsJyAmJiBjb21tYW5kLnN1cHBvcnRzTm9uSW50ZXJhY3RpdmUpLFxuICAgICAgICAgICAgKVxuXG4gICAgICAgIGNvbnN0IGRlZmF1bHRTdGF0ZSA9IGdldERlZmF1bHRBcHBTdGF0ZSgpXG4gICAgICAgIGNvbnN0IGhlYWRsZXNzSW5pdGlhbFN0YXRlOiBBcHBTdGF0ZSA9IHtcbiAgICAgICAgICAuLi5kZWZhdWx0U3RhdGUsXG4gICAgICAgICAgbWNwOiB7XG4gICAgICAgICAgICAuLi5kZWZhdWx0U3RhdGUubWNwLFxuICAgICAgICAgICAgY2xpZW50czogbWNwQ2xpZW50cyxcbiAgICAgICAgICAgIGNvbW1hbmRzOiBtY3BDb21tYW5kcyxcbiAgICAgICAgICAgIHRvb2xzOiBtY3BUb29scyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgICBlZmZvcnRWYWx1ZTpcbiAgICAgICAgICAgIHBhcnNlRWZmb3J0VmFsdWUob3B0aW9ucy5lZmZvcnQpID8/IGdldEluaXRpYWxFZmZvcnRTZXR0aW5nKCksXG4gICAgICAgICAgLi4uKGlzRmFzdE1vZGVFbmFibGVkKCkgJiYge1xuICAgICAgICAgICAgZmFzdE1vZGU6IGdldEluaXRpYWxGYXN0TW9kZVNldHRpbmcoZWZmZWN0aXZlTW9kZWwgPz8gbnVsbCksXG4gICAgICAgICAgfSksXG4gICAgICAgICAgLi4uKGlzQWR2aXNvckVuYWJsZWQoKSAmJiBhZHZpc29yTW9kZWwgJiYgeyBhZHZpc29yTW9kZWwgfSksXG4gICAgICAgICAgLy8ga2Fpcm9zRW5hYmxlZCBnYXRlcyB0aGUgYXN5bmMgZmlyZS1hbmQtZm9yZ2V0IHBhdGggaW5cbiAgICAgICAgICAvLyBleGVjdXRlRm9ya2VkU2xhc2hDb21tYW5kIChwcm9jZXNzU2xhc2hDb21tYW5kLnRzeDoxMzIpIGFuZFxuICAgICAgICAgIC8vIEFnZW50VG9vbCdzIHNob3VsZFJ1bkFzeW5jLiBUaGUgUkVQTCBpbml0aWFsU3RhdGUgc2V0cyB0aGlzIGF0XG4gICAgICAgICAgLy8gfjM0NTk7IGhlYWRsZXNzIHdhcyBkZWZhdWx0aW5nIHRvIGZhbHNlLCBzbyB0aGUgZGFlbW9uIGNoaWxkJ3NcbiAgICAgICAgICAvLyBzY2hlZHVsZWQgdGFza3MgYW5kIEFnZW50LXRvb2wgY2FsbHMgcmFuIHN5bmNocm9ub3VzbHkgXHUyMDE0IE5cbiAgICAgICAgICAvLyBvdmVyZHVlIGNyb24gdGFza3Mgb24gc3Bhd24gPSBOIHNlcmlhbCBzdWJhZ2VudCB0dXJucyBibG9ja2luZ1xuICAgICAgICAgIC8vIHVzZXIgaW5wdXQuIENvbXB1dGVkIGF0IDoxNjIwLCB3ZWxsIGJlZm9yZSB0aGlzIGJyYW5jaC5cbiAgICAgICAgICAuLi4oZmVhdHVyZSgnS0FJUk9TJykgPyB7IGthaXJvc0VuYWJsZWQgfSA6IHt9KSxcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEluaXQgYXBwIHN0YXRlXG4gICAgICAgIGNvbnN0IGhlYWRsZXNzU3RvcmUgPSBjcmVhdGVTdG9yZShcbiAgICAgICAgICBoZWFkbGVzc0luaXRpYWxTdGF0ZSxcbiAgICAgICAgICBvbkNoYW5nZUFwcFN0YXRlLFxuICAgICAgICApXG5cbiAgICAgICAgLy8gQ2hlY2sgaWYgYnlwYXNzUGVybWlzc2lvbnMgc2hvdWxkIGJlIGRpc2FibGVkIGJhc2VkIG9uIFN0YXRzaWcgZ2F0ZVxuICAgICAgICAvLyBUaGlzIHJ1bnMgaW4gcGFyYWxsZWwgdG8gdGhlIGNvZGUgYmVsb3csIHRvIGF2b2lkIGJsb2NraW5nIHRoZSBtYWluIGxvb3AuXG4gICAgICAgIGlmIChcbiAgICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQubW9kZSA9PT0gJ2J5cGFzc1Blcm1pc3Npb25zJyB8fFxuICAgICAgICAgIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNcbiAgICAgICAgKSB7XG4gICAgICAgICAgdm9pZCBjaGVja0FuZERpc2FibGVCeXBhc3NQZXJtaXNzaW9ucyh0b29sUGVybWlzc2lvbkNvbnRleHQpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBBc3luYyBjaGVjayBvZiBhdXRvIG1vZGUgZ2F0ZSBcdTIwMTQgY29ycmVjdHMgc3RhdGUgYW5kIGRpc2FibGVzIGF1dG8gaWYgbmVlZGVkLlxuICAgICAgICAvLyBHYXRlZCBvbiBUUkFOU0NSSVBUX0NMQVNTSUZJRVIgKG5vdCBVU0VSX1RZUEUpIHNvIEdyb3d0aEJvb2sga2lsbCBzd2l0Y2ggcnVucyBmb3IgZXh0ZXJuYWwgYnVpbGRzIHRvby5cbiAgICAgICAgaWYgKGZlYXR1cmUoJ1RSQU5TQ1JJUFRfQ0xBU1NJRklFUicpKSB7XG4gICAgICAgICAgdm9pZCB2ZXJpZnlBdXRvTW9kZUdhdGVBY2Nlc3MoXG4gICAgICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQsXG4gICAgICAgICAgICBoZWFkbGVzc1N0b3JlLmdldFN0YXRlKCkuZmFzdE1vZGUsXG4gICAgICAgICAgKS50aGVuKCh7IHVwZGF0ZUNvbnRleHQgfSkgPT4ge1xuICAgICAgICAgICAgaGVhZGxlc3NTdG9yZS5zZXRTdGF0ZShwcmV2ID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgbmV4dEN0eCA9IHVwZGF0ZUNvbnRleHQocHJldi50b29sUGVybWlzc2lvbkNvbnRleHQpXG4gICAgICAgICAgICAgIGlmIChuZXh0Q3R4ID09PSBwcmV2LnRvb2xQZXJtaXNzaW9uQ29udGV4dCkgcmV0dXJuIHByZXZcbiAgICAgICAgICAgICAgcmV0dXJuIHsgLi4ucHJldiwgdG9vbFBlcm1pc3Npb25Db250ZXh0OiBuZXh0Q3R4IH1cbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfSlcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFNldCBnbG9iYWwgc3RhdGUgZm9yIHNlc3Npb24gcGVyc2lzdGVuY2VcbiAgICAgICAgaWYgKG9wdGlvbnMuc2Vzc2lvblBlcnNpc3RlbmNlID09PSBmYWxzZSkge1xuICAgICAgICAgIHNldFNlc3Npb25QZXJzaXN0ZW5jZURpc2FibGVkKHRydWUpXG4gICAgICAgIH1cblxuICAgICAgICAvLyBTdG9yZSBTREsgYmV0YXMgaW4gZ2xvYmFsIHN0YXRlIGZvciBjb250ZXh0IHdpbmRvdyBjYWxjdWxhdGlvblxuICAgICAgICAvLyBPbmx5IHN0b3JlIGFsbG93ZWQgYmV0YXMgKGZpbHRlcnMgYnkgYWxsb3dsaXN0IGFuZCBzdWJzY3JpYmVyIHN0YXR1cylcbiAgICAgICAgc2V0U2RrQmV0YXMoZmlsdGVyQWxsb3dlZFNka0JldGFzKGJldGFzKSlcblxuICAgICAgICAvLyBQcmludC1tb2RlIE1DUDogcGVyLXNlcnZlciBpbmNyZW1lbnRhbCBwdXNoIGludG8gaGVhZGxlc3NTdG9yZS5cbiAgICAgICAgLy8gTWlycm9ycyB1c2VNYW5hZ2VNQ1BDb25uZWN0aW9ucyBcdTIwMTQgcHVzaCBwZW5kaW5nIGZpcnN0IChzbyBUb29sU2VhcmNoJ3NcbiAgICAgICAgLy8gcGVuZGluZy1jaGVjayBhdCBUb29sU2VhcmNoVG9vbC50czozMzQgc2VlcyB0aGVtKSwgdGhlbiByZXBsYWNlIHdpdGhcbiAgICAgICAgLy8gY29ubmVjdGVkL2ZhaWxlZCBhcyBlYWNoIHNlcnZlciBzZXR0bGVzLlxuICAgICAgICBjb25zdCBjb25uZWN0TWNwQmF0Y2ggPSAoXG4gICAgICAgICAgY29uZmlnczogUmVjb3JkPHN0cmluZywgU2NvcGVkTWNwU2VydmVyQ29uZmlnPixcbiAgICAgICAgICBsYWJlbDogc3RyaW5nLFxuICAgICAgICApOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICAgICAgICBpZiAoT2JqZWN0LmtleXMoY29uZmlncykubGVuZ3RoID09PSAwKSByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKClcbiAgICAgICAgICBoZWFkbGVzc1N0b3JlLnNldFN0YXRlKHByZXYgPT4gKHtcbiAgICAgICAgICAgIC4uLnByZXYsXG4gICAgICAgICAgICBtY3A6IHtcbiAgICAgICAgICAgICAgLi4ucHJldi5tY3AsXG4gICAgICAgICAgICAgIGNsaWVudHM6IFtcbiAgICAgICAgICAgICAgICAuLi5wcmV2Lm1jcC5jbGllbnRzLFxuICAgICAgICAgICAgICAgIC4uLk9iamVjdC5lbnRyaWVzKGNvbmZpZ3MpLm1hcCgoW25hbWUsIGNvbmZpZ10pID0+ICh7XG4gICAgICAgICAgICAgICAgICBuYW1lLFxuICAgICAgICAgICAgICAgICAgdHlwZTogJ3BlbmRpbmcnIGFzIGNvbnN0LFxuICAgICAgICAgICAgICAgICAgY29uZmlnLFxuICAgICAgICAgICAgICAgIH0pKSxcbiAgICAgICAgICAgICAgXSxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSkpXG4gICAgICAgICAgcmV0dXJuIGdldE1jcFRvb2xzQ29tbWFuZHNBbmRSZXNvdXJjZXMoXG4gICAgICAgICAgICAoeyBjbGllbnQsIHRvb2xzLCBjb21tYW5kcyB9KSA9PiB7XG4gICAgICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUocHJldiA9PiAoe1xuICAgICAgICAgICAgICAgIC4uLnByZXYsXG4gICAgICAgICAgICAgICAgbWNwOiB7XG4gICAgICAgICAgICAgICAgICAuLi5wcmV2Lm1jcCxcbiAgICAgICAgICAgICAgICAgIGNsaWVudHM6IHByZXYubWNwLmNsaWVudHMuc29tZShjID0+IGMubmFtZSA9PT0gY2xpZW50Lm5hbWUpXG4gICAgICAgICAgICAgICAgICAgID8gcHJldi5tY3AuY2xpZW50cy5tYXAoYyA9PlxuICAgICAgICAgICAgICAgICAgICAgICAgYy5uYW1lID09PSBjbGllbnQubmFtZSA/IGNsaWVudCA6IGMsXG4gICAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICA6IFsuLi5wcmV2Lm1jcC5jbGllbnRzLCBjbGllbnRdLFxuICAgICAgICAgICAgICAgICAgdG9vbHM6IHVuaXFCeShbLi4ucHJldi5tY3AudG9vbHMsIC4uLnRvb2xzXSwgJ25hbWUnKSxcbiAgICAgICAgICAgICAgICAgIGNvbW1hbmRzOiB1bmlxQnkoWy4uLnByZXYubWNwLmNvbW1hbmRzLCAuLi5jb21tYW5kc10sICduYW1lJyksXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgfSkpXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgY29uZmlncyxcbiAgICAgICAgICApLmNhdGNoKGVyciA9PlxuICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKGBbTUNQXSAke2xhYmVsfSBjb25uZWN0IGVycm9yOiAke2Vycn1gKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgLy8gQXdhaXQgYWxsIE1DUCBjb25maWdzIFx1MjAxNCBwcmludCBtb2RlIGlzIG9mdGVuIHNpbmdsZS10dXJuLCBzb1xuICAgICAgICAvLyBcImxhdGUtY29ubmVjdGluZyBzZXJ2ZXJzIHZpc2libGUgbmV4dCB0dXJuXCIgZG9lc24ndCBoZWxwLiBTREsgaW5pdFxuICAgICAgICAvLyBtZXNzYWdlIGFuZCB0dXJuLTEgdG9vbCBsaXN0IGJvdGggbmVlZCBjb25maWd1cmVkIE1DUCB0b29scyBwcmVzZW50LlxuICAgICAgICAvLyBaZXJvLXNlcnZlciBjYXNlIGlzIGZyZWUgdmlhIHRoZSBlYXJseSByZXR1cm4gaW4gY29ubmVjdE1jcEJhdGNoLlxuICAgICAgICAvLyBDb25uZWN0b3JzIHBhcmFsbGVsaXplIGluc2lkZSBnZXRNY3BUb29sc0NvbW1hbmRzQW5kUmVzb3VyY2VzXG4gICAgICAgIC8vIChwcm9jZXNzQmF0Y2hlZCB3aXRoIFByb21pc2UuYWxsKS4gY2xhdWRlLmFpIGlzIGF3YWl0ZWQgdG9vIFx1MjAxNCBpdHNcbiAgICAgICAgLy8gZmV0Y2ggd2FzIGtpY2tlZCBvZmYgZWFybHkgKGxpbmUgfjI1NTgpIHNvIG9ubHkgcmVzaWR1YWwgdGltZSBibG9ja3NcbiAgICAgICAgLy8gaGVyZS4gLS1iYXJlIHNraXBzIGNsYXVkZS5haSBlbnRpcmVseSBmb3IgcGVyZi1zZW5zaXRpdmUgc2NyaXB0cy5cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2JlZm9yZV9jb25uZWN0TWNwJylcbiAgICAgICAgYXdhaXQgY29ubmVjdE1jcEJhdGNoKHJlZ3VsYXJNY3BDb25maWdzLCAncmVndWxhcicpXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdhZnRlcl9jb25uZWN0TWNwJylcbiAgICAgICAgLy8gRGVkdXA6IHN1cHByZXNzIHBsdWdpbiBNQ1Agc2VydmVycyB0aGF0IGR1cGxpY2F0ZSBhIGNsYXVkZS5haVxuICAgICAgICAvLyBjb25uZWN0b3IgKGNvbm5lY3RvciB3aW5zKSwgdGhlbiBjb25uZWN0IGNsYXVkZS5haSBzZXJ2ZXJzLlxuICAgICAgICAvLyBCb3VuZGVkIHdhaXQgXHUyMDE0ICMyMzcyNSBtYWRlIHRoaXMgYmxvY2tpbmcgc28gc2luZ2xlLXR1cm4gLXAgc2Vlc1xuICAgICAgICAvLyBjb25uZWN0b3JzLCBidXQgd2l0aCA0MCsgc2xvdyBjb25uZWN0b3JzIHRlbmd1X3N0YXJ0dXBfcGVyZiBwOTlcbiAgICAgICAgLy8gY2xpbWJlZCB0byA3NnMuIElmIGZldGNoK2Nvbm5lY3QgZG9lc24ndCBmaW5pc2ggaW4gdGltZSwgcHJvY2VlZDtcbiAgICAgICAgLy8gdGhlIHByb21pc2Uga2VlcHMgcnVubmluZyBhbmQgdXBkYXRlcyBoZWFkbGVzc1N0b3JlIGluIHRoZVxuICAgICAgICAvLyBiYWNrZ3JvdW5kIHNvIHR1cm4gMisgc3RpbGwgc2VlcyBjb25uZWN0b3JzLlxuICAgICAgICBjb25zdCBDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMgPSA1XzAwMFxuICAgICAgICBjb25zdCBjbGF1ZGVhaUNvbm5lY3QgPSBjbGF1ZGVhaUNvbmZpZ1Byb21pc2UudGhlbihjbGF1ZGVhaUNvbmZpZ3MgPT4ge1xuICAgICAgICAgIGlmIChPYmplY3Qua2V5cyhjbGF1ZGVhaUNvbmZpZ3MpLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGNvbnN0IGNsYXVkZWFpU2lncyA9IG5ldyBTZXQ8c3RyaW5nPigpXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGNvbmZpZyBvZiBPYmplY3QudmFsdWVzKGNsYXVkZWFpQ29uZmlncykpIHtcbiAgICAgICAgICAgICAgY29uc3Qgc2lnID0gZ2V0TWNwU2VydmVyU2lnbmF0dXJlKGNvbmZpZylcbiAgICAgICAgICAgICAgaWYgKHNpZykgY2xhdWRlYWlTaWdzLmFkZChzaWcpXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zdCBzdXBwcmVzc2VkID0gbmV3IFNldDxzdHJpbmc+KClcbiAgICAgICAgICAgIGZvciAoY29uc3QgW25hbWUsIGNvbmZpZ10gb2YgT2JqZWN0LmVudHJpZXMocmVndWxhck1jcENvbmZpZ3MpKSB7XG4gICAgICAgICAgICAgIGlmICghbmFtZS5zdGFydHNXaXRoKCdwbHVnaW46JykpIGNvbnRpbnVlXG4gICAgICAgICAgICAgIGNvbnN0IHNpZyA9IGdldE1jcFNlcnZlclNpZ25hdHVyZShjb25maWcpXG4gICAgICAgICAgICAgIGlmIChzaWcgJiYgY2xhdWRlYWlTaWdzLmhhcyhzaWcpKSBzdXBwcmVzc2VkLmFkZChuYW1lKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKHN1cHByZXNzZWQuc2l6ZSA+IDApIHtcbiAgICAgICAgICAgICAgbG9nRm9yRGVidWdnaW5nKFxuICAgICAgICAgICAgICAgIGBbTUNQXSBMYXp5IGRlZHVwOiBzdXBwcmVzc2luZyAke3N1cHByZXNzZWQuc2l6ZX0gcGx1Z2luIHNlcnZlcihzKSB0aGF0IGR1cGxpY2F0ZSBjbGF1ZGUuYWkgY29ubmVjdG9yczogJHtbLi4uc3VwcHJlc3NlZF0uam9pbignLCAnKX1gLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIC8vIERpc2Nvbm5lY3QgYmVmb3JlIGZpbHRlcmluZyBmcm9tIHN0YXRlLiBPbmx5IGNvbm5lY3RlZFxuICAgICAgICAgICAgICAvLyBzZXJ2ZXJzIG5lZWQgY2xlYW51cCBcdTIwMTQgY2xlYXJTZXJ2ZXJDYWNoZSBvbiBhIG5ldmVyLWNvbm5lY3RlZFxuICAgICAgICAgICAgICAvLyBzZXJ2ZXIgdHJpZ2dlcnMgYSByZWFsIGNvbm5lY3QganVzdCB0byBraWxsIGl0IChtZW1vaXplXG4gICAgICAgICAgICAgIC8vIGNhY2hlLW1pc3MgcGF0aCwgc2VlIHVzZU1hbmFnZU1DUENvbm5lY3Rpb25zLnRzOjg3MCkuXG4gICAgICAgICAgICAgIGZvciAoY29uc3QgYyBvZiBoZWFkbGVzc1N0b3JlLmdldFN0YXRlKCkubWNwLmNsaWVudHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXN1cHByZXNzZWQuaGFzKGMubmFtZSkgfHwgYy50eXBlICE9PSAnY29ubmVjdGVkJykgY29udGludWVcbiAgICAgICAgICAgICAgICBjLmNsaWVudC5vbmNsb3NlID0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgdm9pZCBjbGVhclNlcnZlckNhY2hlKGMubmFtZSwgYy5jb25maWcpLmNhdGNoKCgpID0+IHt9KVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUocHJldiA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IHsgY2xpZW50cywgdG9vbHMsIGNvbW1hbmRzLCByZXNvdXJjZXMgfSA9IHByZXYubWNwXG4gICAgICAgICAgICAgICAgY2xpZW50cyA9IGNsaWVudHMuZmlsdGVyKGMgPT4gIXN1cHByZXNzZWQuaGFzKGMubmFtZSkpXG4gICAgICAgICAgICAgICAgdG9vbHMgPSB0b29scy5maWx0ZXIoXG4gICAgICAgICAgICAgICAgICB0ID0+ICF0Lm1jcEluZm8gfHwgIXN1cHByZXNzZWQuaGFzKHQubWNwSW5mby5zZXJ2ZXJOYW1lKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgZm9yIChjb25zdCBuYW1lIG9mIHN1cHByZXNzZWQpIHtcbiAgICAgICAgICAgICAgICAgIGNvbW1hbmRzID0gZXhjbHVkZUNvbW1hbmRzQnlTZXJ2ZXIoY29tbWFuZHMsIG5hbWUpXG4gICAgICAgICAgICAgICAgICByZXNvdXJjZXMgPSBleGNsdWRlUmVzb3VyY2VzQnlTZXJ2ZXIocmVzb3VyY2VzLCBuYW1lKVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgLi4ucHJldixcbiAgICAgICAgICAgICAgICAgIG1jcDogeyAuLi5wcmV2Lm1jcCwgY2xpZW50cywgdG9vbHMsIGNvbW1hbmRzLCByZXNvdXJjZXMgfSxcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFN1cHByZXNzIGNsYXVkZS5haSBjb25uZWN0b3JzIHRoYXQgZHVwbGljYXRlIGFuIGVuYWJsZWRcbiAgICAgICAgICAvLyBtYW51YWwgc2VydmVyIChVUkwtc2lnbmF0dXJlIG1hdGNoKS4gUGx1Z2luIGRlZHVwIGFib3ZlIG9ubHlcbiAgICAgICAgICAvLyBoYW5kbGVzIGBwbHVnaW46KmAga2V5czsgdGhpcyBjYXRjaGVzIG1hbnVhbCBgLm1jcC5qc29uYCBlbnRyaWVzLlxuICAgICAgICAgIC8vIHBsdWdpbjoqIG11c3QgYmUgZXhjbHVkZWQgaGVyZSBcdTIwMTQgc3RlcCAxIGFscmVhZHkgc3VwcHJlc3NlZFxuICAgICAgICAgIC8vIHRob3NlIChjbGF1ZGUuYWkgd2lucyk7IGxlYXZpbmcgdGhlbSBpbiBzdXBwcmVzc2VzIHRoZVxuICAgICAgICAgIC8vIGNvbm5lY3RvciB0b28sIGFuZCBuZWl0aGVyIHN1cnZpdmVzIChnaC0zOTk3NCkuXG4gICAgICAgICAgY29uc3Qgbm9uUGx1Z2luQ29uZmlncyA9IHBpY2tCeShcbiAgICAgICAgICAgIHJlZ3VsYXJNY3BDb25maWdzLFxuICAgICAgICAgICAgKF8sIG4pID0+ICFuLnN0YXJ0c1dpdGgoJ3BsdWdpbjonKSxcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3QgeyBzZXJ2ZXJzOiBkZWR1cGVkQ2xhdWRlQWkgfSA9IGRlZHVwQ2xhdWRlQWlNY3BTZXJ2ZXJzKFxuICAgICAgICAgICAgY2xhdWRlYWlDb25maWdzLFxuICAgICAgICAgICAgbm9uUGx1Z2luQ29uZmlncyxcbiAgICAgICAgICApXG4gICAgICAgICAgcmV0dXJuIGNvbm5lY3RNY3BCYXRjaChkZWR1cGVkQ2xhdWRlQWksICdjbGF1ZGVhaScpXG4gICAgICAgIH0pXG4gICAgICAgIGxldCBjbGF1ZGVhaVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZFxuICAgICAgICBjb25zdCBjbGF1ZGVhaVRpbWVkT3V0ID0gYXdhaXQgUHJvbWlzZS5yYWNlKFtcbiAgICAgICAgICBjbGF1ZGVhaUNvbm5lY3QudGhlbigoKSA9PiBmYWxzZSksXG4gICAgICAgICAgbmV3IFByb21pc2U8Ym9vbGVhbj4ocmVzb2x2ZSA9PiB7XG4gICAgICAgICAgICBjbGF1ZGVhaVRpbWVyID0gc2V0VGltZW91dChcbiAgICAgICAgICAgICAgciA9PiByKHRydWUpLFxuICAgICAgICAgICAgICBDTEFVREVfQUlfTUNQX1RJTUVPVVRfTVMsXG4gICAgICAgICAgICAgIHJlc29sdmUsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfSksXG4gICAgICAgIF0pXG4gICAgICAgIGlmIChjbGF1ZGVhaVRpbWVyKSBjbGVhclRpbWVvdXQoY2xhdWRlYWlUaW1lcilcbiAgICAgICAgaWYgKGNsYXVkZWFpVGltZWRPdXQpIHtcbiAgICAgICAgICBsb2dGb3JEZWJ1Z2dpbmcoXG4gICAgICAgICAgICBgW01DUF0gY2xhdWRlLmFpIGNvbm5lY3RvcnMgbm90IHJlYWR5IGFmdGVyICR7Q0xBVURFX0FJX01DUF9USU1FT1VUX01TfW1zIFx1MjAxNCBwcm9jZWVkaW5nOyBiYWNrZ3JvdW5kIGNvbm5lY3Rpb24gY29udGludWVzYCxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FmdGVyX2Nvbm5lY3RNY3BfY2xhdWRlYWknKVxuXG4gICAgICAgIC8vIEluIGhlYWRsZXNzIG1vZGUsIHN0YXJ0IGRlZmVycmVkIHByZWZldGNoZXMgaW1tZWRpYXRlbHkgKG5vIHVzZXIgdHlwaW5nIGRlbGF5KVxuICAgICAgICAvLyAtLWJhcmUgLyBTSU1QTEU6IHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzIGVhcmx5LXJldHVybnMgaW50ZXJuYWxseS5cbiAgICAgICAgLy8gYmFja2dyb3VuZEhvdXNla2VlcGluZyAoaW5pdEV4dHJhY3RNZW1vcmllcywgcHJ1bmVTaGVsbFNuYXBzaG90cyxcbiAgICAgICAgLy8gY2xlYW51cE9sZE1lc3NhZ2VGaWxlcykgYW5kIHNka0hlYXBEdW1wTW9uaXRvciBhcmUgYWxsIGJvb2trZWVwaW5nXG4gICAgICAgIC8vIHRoYXQgc2NyaXB0ZWQgY2FsbHMgZG9uJ3QgbmVlZCBcdTIwMTQgdGhlIG5leHQgaW50ZXJhY3RpdmUgc2Vzc2lvbiByZWNvbmNpbGVzLlxuICAgICAgICBpZiAoIWlzQmFyZU1vZGUoKSkge1xuICAgICAgICAgIHN0YXJ0RGVmZXJyZWRQcmVmZXRjaGVzKClcbiAgICAgICAgICB2b2lkIGltcG9ydCgnLi91dGlscy9iYWNrZ3JvdW5kSG91c2VrZWVwaW5nLmpzJykudGhlbihtID0+XG4gICAgICAgICAgICBtLnN0YXJ0QmFja2dyb3VuZEhvdXNla2VlcGluZygpLFxuICAgICAgICAgIClcbiAgICAgICAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgICAgICAgICAgdm9pZCBpbXBvcnQoJy4vdXRpbHMvc2RrSGVhcER1bXBNb25pdG9yLmpzJykudGhlbihtID0+XG4gICAgICAgICAgICAgIG0uc3RhcnRTZGtNZW1vcnlNb25pdG9yKCksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbG9nU2Vzc2lvblRlbGVtZXRyeSgpXG4gICAgICAgIHByb2ZpbGVDaGVja3BvaW50KCdiZWZvcmVfcHJpbnRfaW1wb3J0JylcbiAgICAgICAgY29uc3QgeyBydW5IZWFkbGVzcyB9ID0gYXdhaXQgaW1wb3J0KCdzcmMvY2xpL3ByaW50LmpzJylcbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FmdGVyX3ByaW50X2ltcG9ydCcpXG4gICAgICAgIHZvaWQgcnVuSGVhZGxlc3MoXG4gICAgICAgICAgaW5wdXRQcm9tcHQsXG4gICAgICAgICAgKCkgPT4gaGVhZGxlc3NTdG9yZS5nZXRTdGF0ZSgpLFxuICAgICAgICAgIGhlYWRsZXNzU3RvcmUuc2V0U3RhdGUsXG4gICAgICAgICAgY29tbWFuZHNIZWFkbGVzcyxcbiAgICAgICAgICB0b29scyxcbiAgICAgICAgICBzZGtNY3BDb25maWdzLFxuICAgICAgICAgIGFnZW50RGVmaW5pdGlvbnMuYWN0aXZlQWdlbnRzLFxuICAgICAgICAgIHtcbiAgICAgICAgICAgIGNvbnRpbnVlOiBvcHRpb25zLmNvbnRpbnVlLFxuICAgICAgICAgICAgcmVzdW1lOiBvcHRpb25zLnJlc3VtZSxcbiAgICAgICAgICAgIHZlcmJvc2U6IHZlcmJvc2UsXG4gICAgICAgICAgICBvdXRwdXRGb3JtYXQ6IG91dHB1dEZvcm1hdCxcbiAgICAgICAgICAgIGpzb25TY2hlbWEsXG4gICAgICAgICAgICBwZXJtaXNzaW9uUHJvbXB0VG9vbE5hbWU6IG9wdGlvbnMucGVybWlzc2lvblByb21wdFRvb2wsXG4gICAgICAgICAgICBhbGxvd2VkVG9vbHMsXG4gICAgICAgICAgICB0aGlua2luZ0NvbmZpZyxcbiAgICAgICAgICAgIG1heFR1cm5zOiBvcHRpb25zLm1heFR1cm5zLFxuICAgICAgICAgICAgbWF4QnVkZ2V0VXNkOiBvcHRpb25zLm1heEJ1ZGdldFVzZCxcbiAgICAgICAgICAgIHRhc2tCdWRnZXQ6IG9wdGlvbnMudGFza0J1ZGdldFxuICAgICAgICAgICAgICA/IHsgdG90YWw6IG9wdGlvbnMudGFza0J1ZGdldCB9XG4gICAgICAgICAgICAgIDogdW5kZWZpbmVkLFxuICAgICAgICAgICAgc3lzdGVtUHJvbXB0LFxuICAgICAgICAgICAgYXBwZW5kU3lzdGVtUHJvbXB0LFxuICAgICAgICAgICAgdXNlclNwZWNpZmllZE1vZGVsOiBlZmZlY3RpdmVNb2RlbCxcbiAgICAgICAgICAgIGZhbGxiYWNrTW9kZWw6IHVzZXJTcGVjaWZpZWRGYWxsYmFja01vZGVsLFxuICAgICAgICAgICAgdGVsZXBvcnQsXG4gICAgICAgICAgICBzZGtVcmwsXG4gICAgICAgICAgICByZXBsYXlVc2VyTWVzc2FnZXM6IGVmZmVjdGl2ZVJlcGxheVVzZXJNZXNzYWdlcyxcbiAgICAgICAgICAgIGluY2x1ZGVQYXJ0aWFsTWVzc2FnZXM6IGVmZmVjdGl2ZUluY2x1ZGVQYXJ0aWFsTWVzc2FnZXMsXG4gICAgICAgICAgICBmb3JrU2Vzc2lvbjogb3B0aW9ucy5mb3JrU2Vzc2lvbiB8fCBmYWxzZSxcbiAgICAgICAgICAgIHJlc3VtZVNlc3Npb25BdDogb3B0aW9ucy5yZXN1bWVTZXNzaW9uQXQgfHwgdW5kZWZpbmVkLFxuICAgICAgICAgICAgcmV3aW5kRmlsZXM6IG9wdGlvbnMucmV3aW5kRmlsZXMsXG4gICAgICAgICAgICBlbmFibGVBdXRoU3RhdHVzOiBvcHRpb25zLmVuYWJsZUF1dGhTdGF0dXMsXG4gICAgICAgICAgICBhZ2VudDogYWdlbnRDbGksXG4gICAgICAgICAgICB3b3JrbG9hZDogb3B0aW9ucy53b3JrbG9hZCxcbiAgICAgICAgICAgIHNldHVwVHJpZ2dlcjogc2V0dXBUcmlnZ2VyID8/IHVuZGVmaW5lZCxcbiAgICAgICAgICAgIHNlc3Npb25TdGFydEhvb2tzUHJvbWlzZSxcbiAgICAgICAgICB9LFxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgfVxuXG4gICAgICAvLyBMb2cgbW9kZWwgY29uZmlnIGF0IHN0YXJ0dXBcbiAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zdGFydHVwX21hbnVhbF9tb2RlbF9jb25maWcnLCB7XG4gICAgICAgIGNsaV9mbGFnOlxuICAgICAgICAgIG9wdGlvbnMubW9kZWwgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgZW52X3ZhcjogcHJvY2Vzcy5lbnZcbiAgICAgICAgICAuQU5USFJPUElDX01PREVMIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgIHNldHRpbmdzX2ZpbGU6IChnZXRJbml0aWFsU2V0dGluZ3MoKSB8fCB7fSlcbiAgICAgICAgICAubW9kZWwgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgc3Vic2NyaXB0aW9uVHlwZTpcbiAgICAgICAgICBnZXRTdWJzY3JpcHRpb25UeXBlKCkgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgYWdlbnQ6XG4gICAgICAgICAgYWdlbnRTZXR0aW5nIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KVxuXG4gICAgICAvLyBHZXQgZGVwcmVjYXRpb24gd2FybmluZyBmb3IgdGhlIGluaXRpYWwgbW9kZWwgKHJlc29sdmVkSW5pdGlhbE1vZGVsIGNvbXB1dGVkIGVhcmxpZXIgZm9yIGhvb2tzIHBhcmFsbGVsaXphdGlvbilcbiAgICAgIGNvbnN0IGRlcHJlY2F0aW9uV2FybmluZyA9XG4gICAgICAgIGdldE1vZGVsRGVwcmVjYXRpb25XYXJuaW5nKHJlc29sdmVkSW5pdGlhbE1vZGVsKVxuXG4gICAgICAvLyBCdWlsZCBpbml0aWFsIG5vdGlmaWNhdGlvbiBxdWV1ZVxuICAgICAgY29uc3QgaW5pdGlhbE5vdGlmaWNhdGlvbnM6IEFycmF5PHtcbiAgICAgICAga2V5OiBzdHJpbmdcbiAgICAgICAgdGV4dDogc3RyaW5nXG4gICAgICAgIGNvbG9yPzogJ3dhcm5pbmcnXG4gICAgICAgIHByaW9yaXR5OiAnaGlnaCdcbiAgICAgIH0+ID0gW11cbiAgICAgIGlmIChwZXJtaXNzaW9uTW9kZU5vdGlmaWNhdGlvbikge1xuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdwZXJtaXNzaW9uLW1vZGUtbm90aWZpY2F0aW9uJyxcbiAgICAgICAgICB0ZXh0OiBwZXJtaXNzaW9uTW9kZU5vdGlmaWNhdGlvbixcbiAgICAgICAgICBwcmlvcml0eTogJ2hpZ2gnLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgaWYgKGRlcHJlY2F0aW9uV2FybmluZykge1xuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdtb2RlbC1kZXByZWNhdGlvbi13YXJuaW5nJyxcbiAgICAgICAgICB0ZXh0OiBkZXByZWNhdGlvbldhcm5pbmcsXG4gICAgICAgICAgY29sb3I6ICd3YXJuaW5nJyxcbiAgICAgICAgICBwcmlvcml0eTogJ2hpZ2gnLFxuICAgICAgICB9KVxuICAgICAgfVxuICAgICAgaWYgKG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc3QgZGlzcGxheUxpc3QgPSB1bmlxKFxuICAgICAgICAgIG92ZXJseUJyb2FkQmFzaFBlcm1pc3Npb25zLm1hcChwID0+IHAucnVsZURpc3BsYXkpLFxuICAgICAgICApXG4gICAgICAgIGNvbnN0IGRpc3BsYXlzID0gZGlzcGxheUxpc3Quam9pbignLCAnKVxuICAgICAgICBjb25zdCBzb3VyY2VzID0gdW5pcShcbiAgICAgICAgICBvdmVybHlCcm9hZEJhc2hQZXJtaXNzaW9ucy5tYXAocCA9PiBwLnNvdXJjZURpc3BsYXkpLFxuICAgICAgICApLmpvaW4oJywgJylcbiAgICAgICAgY29uc3QgbiA9IGRpc3BsYXlMaXN0Lmxlbmd0aFxuICAgICAgICBpbml0aWFsTm90aWZpY2F0aW9ucy5wdXNoKHtcbiAgICAgICAgICBrZXk6ICdvdmVybHktYnJvYWQtYmFzaC1ub3RpZmljYXRpb24nLFxuICAgICAgICAgIHRleHQ6IGAke2Rpc3BsYXlzfSBhbGxvdyAke3BsdXJhbChuLCAncnVsZScpfSBmcm9tICR7c291cmNlc30gJHtwbHVyYWwobiwgJ3dhcycsICd3ZXJlJyl9IGlnbm9yZWQgXFx1MjAxNCBub3QgYXZhaWxhYmxlIGZvciBBbnRzLCBwbGVhc2UgdXNlIGF1dG8tbW9kZSBpbnN0ZWFkYCxcbiAgICAgICAgICBjb2xvcjogJ3dhcm5pbmcnLFxuICAgICAgICAgIHByaW9yaXR5OiAnaGlnaCcsXG4gICAgICAgIH0pXG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVmZmVjdGl2ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCA9IHtcbiAgICAgICAgLi4udG9vbFBlcm1pc3Npb25Db250ZXh0LFxuICAgICAgICBtb2RlOlxuICAgICAgICAgIGlzQWdlbnRTd2FybXNFbmFibGVkKCkgJiYgZ2V0VGVhbW1hdGVVdGlscygpLmlzUGxhbk1vZGVSZXF1aXJlZCgpXG4gICAgICAgICAgICA/ICgncGxhbicgYXMgY29uc3QpXG4gICAgICAgICAgICA6IHRvb2xQZXJtaXNzaW9uQ29udGV4dC5tb2RlLFxuICAgICAgfVxuICAgICAgLy8gQWxsIHN0YXJ0dXAgb3B0LWluIHBhdGhzICgtLXRvb2xzLCAtLWJyaWVmLCBkZWZhdWx0VmlldykgaGF2ZSBmaXJlZFxuICAgICAgLy8gYWJvdmU7IGluaXRpYWxJc0JyaWVmT25seSBqdXN0IHJlYWRzIHRoZSByZXN1bHRpbmcgc3RhdGUuXG4gICAgICBjb25zdCBpbml0aWFsSXNCcmllZk9ubHkgPVxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKSA/IGdldFVzZXJNc2dPcHRJbigpIDogZmFsc2VcbiAgICAgIGNvbnN0IGZ1bGxSZW1vdGVDb250cm9sID1cbiAgICAgICAgcmVtb3RlQ29udHJvbCB8fCBnZXRSZW1vdGVDb250cm9sQXRTdGFydHVwKCkgfHwga2Fpcm9zRW5hYmxlZFxuICAgICAgbGV0IGNjck1pcnJvckVuYWJsZWQgPSBmYWxzZVxuICAgICAgaWYgKGZlYXR1cmUoJ0NDUl9NSVJST1InKSAmJiAhZnVsbFJlbW90ZUNvbnRyb2wpIHtcbiAgICAgICAgLyogZXNsaW50LWRpc2FibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjb25zdCB7IGlzQ2NyTWlycm9yRW5hYmxlZCB9ID1cbiAgICAgICAgICByZXF1aXJlKCcuL2JyaWRnZS9icmlkZ2VFbmFibGVkLmpzJykgYXMgdHlwZW9mIGltcG9ydCgnLi9icmlkZ2UvYnJpZGdlRW5hYmxlZC5qcycpXG4gICAgICAgIC8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICAgICAgICBjY3JNaXJyb3JFbmFibGVkID0gaXNDY3JNaXJyb3JFbmFibGVkKClcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5pdGlhbFN0YXRlOiBBcHBTdGF0ZSA9IHtcbiAgICAgICAgc2V0dGluZ3M6IGdldEluaXRpYWxTZXR0aW5ncygpLFxuICAgICAgICB0YXNrczoge30sXG4gICAgICAgIGFnZW50TmFtZVJlZ2lzdHJ5OiBuZXcgTWFwKCksXG4gICAgICAgIHZlcmJvc2U6IHZlcmJvc2UgPz8gZ2V0R2xvYmFsQ29uZmlnKCkudmVyYm9zZSA/PyBmYWxzZSxcbiAgICAgICAgbWFpbkxvb3BNb2RlbDogaW5pdGlhbE1haW5Mb29wTW9kZWwsXG4gICAgICAgIG1haW5Mb29wTW9kZWxGb3JTZXNzaW9uOiBudWxsLFxuICAgICAgICBpc0JyaWVmT25seTogaW5pdGlhbElzQnJpZWZPbmx5LFxuICAgICAgICBleHBhbmRlZFZpZXc6IGdldEdsb2JhbENvbmZpZygpLnNob3dTcGlubmVyVHJlZVxuICAgICAgICAgID8gJ3RlYW1tYXRlcydcbiAgICAgICAgICA6IGdldEdsb2JhbENvbmZpZygpLnNob3dFeHBhbmRlZFRvZG9zXG4gICAgICAgICAgICA/ICd0YXNrcydcbiAgICAgICAgICAgIDogJ25vbmUnLFxuICAgICAgICBzaG93VGVhbW1hdGVNZXNzYWdlUHJldmlldzogaXNBZ2VudFN3YXJtc0VuYWJsZWQoKSA/IGZhbHNlIDogdW5kZWZpbmVkLFxuICAgICAgICBzZWxlY3RlZElQQWdlbnRJbmRleDogLTEsXG4gICAgICAgIGNvb3JkaW5hdG9yVGFza0luZGV4OiAtMSxcbiAgICAgICAgdmlld1NlbGVjdGlvbk1vZGU6ICdub25lJyxcbiAgICAgICAgZm9vdGVyU2VsZWN0aW9uOiBudWxsLFxuICAgICAgICB0b29sUGVybWlzc2lvbkNvbnRleHQ6IGVmZmVjdGl2ZVRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgYWdlbnQ6IG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24/LmFnZW50VHlwZSxcbiAgICAgICAgYWdlbnREZWZpbml0aW9ucyxcbiAgICAgICAgbWNwOiB7XG4gICAgICAgICAgY2xpZW50czogW10sXG4gICAgICAgICAgdG9vbHM6IFtdLFxuICAgICAgICAgIGNvbW1hbmRzOiBbXSxcbiAgICAgICAgICByZXNvdXJjZXM6IHt9LFxuICAgICAgICAgIHBsdWdpblJlY29ubmVjdEtleTogMCxcbiAgICAgICAgfSxcbiAgICAgICAgcGx1Z2luczoge1xuICAgICAgICAgIGVuYWJsZWQ6IFtdLFxuICAgICAgICAgIGRpc2FibGVkOiBbXSxcbiAgICAgICAgICBjb21tYW5kczogW10sXG4gICAgICAgICAgZXJyb3JzOiBbXSxcbiAgICAgICAgICBpbnN0YWxsYXRpb25TdGF0dXM6IHtcbiAgICAgICAgICAgIG1hcmtldHBsYWNlczogW10sXG4gICAgICAgICAgICBwbHVnaW5zOiBbXSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIG5lZWRzUmVmcmVzaDogZmFsc2UsXG4gICAgICAgIH0sXG4gICAgICAgIHN0YXR1c0xpbmVUZXh0OiB1bmRlZmluZWQsXG4gICAgICAgIGthaXJvc0VuYWJsZWQsXG4gICAgICAgIHJlbW90ZVNlc3Npb25Vcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVtb3RlQ29ubmVjdGlvblN0YXR1czogJ2Nvbm5lY3RpbmcnLFxuICAgICAgICByZW1vdGVCYWNrZ3JvdW5kVGFza0NvdW50OiAwLFxuICAgICAgICByZXBsQnJpZGdlRW5hYmxlZDogZnVsbFJlbW90ZUNvbnRyb2wgfHwgY2NyTWlycm9yRW5hYmxlZCxcbiAgICAgICAgcmVwbEJyaWRnZUV4cGxpY2l0OiByZW1vdGVDb250cm9sLFxuICAgICAgICByZXBsQnJpZGdlT3V0Ym91bmRPbmx5OiBjY3JNaXJyb3JFbmFibGVkLFxuICAgICAgICByZXBsQnJpZGdlQ29ubmVjdGVkOiBmYWxzZSxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25BY3RpdmU6IGZhbHNlLFxuICAgICAgICByZXBsQnJpZGdlUmVjb25uZWN0aW5nOiBmYWxzZSxcbiAgICAgICAgcmVwbEJyaWRnZUNvbm5lY3RVcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25Vcmw6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZUVudmlyb25tZW50SWQ6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZVNlc3Npb25JZDogdW5kZWZpbmVkLFxuICAgICAgICByZXBsQnJpZGdlRXJyb3I6IHVuZGVmaW5lZCxcbiAgICAgICAgcmVwbEJyaWRnZUluaXRpYWxOYW1lOiByZW1vdGVDb250cm9sTmFtZSxcbiAgICAgICAgc2hvd1JlbW90ZUNhbGxvdXQ6IGZhbHNlLFxuICAgICAgICBub3RpZmljYXRpb25zOiB7XG4gICAgICAgICAgY3VycmVudDogbnVsbCxcbiAgICAgICAgICBxdWV1ZTogaW5pdGlhbE5vdGlmaWNhdGlvbnMsXG4gICAgICAgIH0sXG4gICAgICAgIGVsaWNpdGF0aW9uOiB7XG4gICAgICAgICAgcXVldWU6IFtdLFxuICAgICAgICB9LFxuICAgICAgICB0b2Rvczoge30sXG4gICAgICAgIHJlbW90ZUFnZW50VGFza1N1Z2dlc3Rpb25zOiBbXSxcbiAgICAgICAgZmlsZUhpc3Rvcnk6IHtcbiAgICAgICAgICBzbmFwc2hvdHM6IFtdLFxuICAgICAgICAgIHRyYWNrZWRGaWxlczogbmV3IFNldCgpLFxuICAgICAgICAgIHNuYXBzaG90U2VxdWVuY2U6IDAsXG4gICAgICAgIH0sXG4gICAgICAgIGF0dHJpYnV0aW9uOiBjcmVhdGVFbXB0eUF0dHJpYnV0aW9uU3RhdGUoKSxcbiAgICAgICAgdGhpbmtpbmdFbmFibGVkLFxuICAgICAgICBwcm9tcHRTdWdnZXN0aW9uRW5hYmxlZDogc2hvdWxkRW5hYmxlUHJvbXB0U3VnZ2VzdGlvbigpLFxuICAgICAgICBzZXNzaW9uSG9va3M6IG5ldyBNYXAoKSxcbiAgICAgICAgaW5ib3g6IHtcbiAgICAgICAgICBtZXNzYWdlczogW10sXG4gICAgICAgIH0sXG4gICAgICAgIHByb21wdFN1Z2dlc3Rpb246IHtcbiAgICAgICAgICB0ZXh0OiBudWxsLFxuICAgICAgICAgIHByb21wdElkOiBudWxsLFxuICAgICAgICAgIHNob3duQXQ6IDAsXG4gICAgICAgICAgYWNjZXB0ZWRBdDogMCxcbiAgICAgICAgICBnZW5lcmF0aW9uUmVxdWVzdElkOiBudWxsLFxuICAgICAgICB9LFxuICAgICAgICBzcGVjdWxhdGlvbjogSURMRV9TUEVDVUxBVElPTl9TVEFURSxcbiAgICAgICAgc3BlY3VsYXRpb25TZXNzaW9uVGltZVNhdmVkTXM6IDAsXG4gICAgICAgIHNraWxsSW1wcm92ZW1lbnQ6IHtcbiAgICAgICAgICBzdWdnZXN0aW9uOiBudWxsLFxuICAgICAgICB9LFxuICAgICAgICB3b3JrZXJTYW5kYm94UGVybWlzc2lvbnM6IHtcbiAgICAgICAgICBxdWV1ZTogW10sXG4gICAgICAgICAgc2VsZWN0ZWRJbmRleDogMCxcbiAgICAgICAgfSxcbiAgICAgICAgcGVuZGluZ1dvcmtlclJlcXVlc3Q6IG51bGwsXG4gICAgICAgIHBlbmRpbmdTYW5kYm94UmVxdWVzdDogbnVsbCxcbiAgICAgICAgYXV0aFZlcnNpb246IDAsXG4gICAgICAgIGluaXRpYWxNZXNzYWdlOiBpbnB1dFByb21wdFxuICAgICAgICAgID8geyBtZXNzYWdlOiBjcmVhdGVVc2VyTWVzc2FnZSh7IGNvbnRlbnQ6IFN0cmluZyhpbnB1dFByb21wdCkgfSkgfVxuICAgICAgICAgIDogbnVsbCxcbiAgICAgICAgZWZmb3J0VmFsdWU6XG4gICAgICAgICAgcGFyc2VFZmZvcnRWYWx1ZShvcHRpb25zLmVmZm9ydCkgPz8gZ2V0SW5pdGlhbEVmZm9ydFNldHRpbmcoKSxcbiAgICAgICAgYWN0aXZlT3ZlcmxheXM6IG5ldyBTZXQ8c3RyaW5nPigpLFxuICAgICAgICBmYXN0TW9kZTogZ2V0SW5pdGlhbEZhc3RNb2RlU2V0dGluZyhyZXNvbHZlZEluaXRpYWxNb2RlbCksXG4gICAgICAgIC4uLihpc0Fkdmlzb3JFbmFibGVkKCkgJiYgYWR2aXNvck1vZGVsICYmIHsgYWR2aXNvck1vZGVsIH0pLFxuICAgICAgICAvLyBDb21wdXRlIHRlYW1Db250ZXh0IHN5bmNocm9ub3VzbHkgdG8gYXZvaWQgdXNlRWZmZWN0IHNldFN0YXRlIGR1cmluZyByZW5kZXIuXG4gICAgICAgIC8vIEtBSVJPUzogYXNzaXN0YW50VGVhbUNvbnRleHQgdGFrZXMgcHJlY2VkZW5jZSBcdTIwMTQgc2V0IGVhcmxpZXIgaW4gdGhlXG4gICAgICAgIC8vIEtBSVJPUyBibG9jayBzbyBBZ2VudChuYW1lOiBcImZvb1wiKSBjYW4gc3Bhd24gaW4tcHJvY2VzcyB0ZWFtbWF0ZXNcbiAgICAgICAgLy8gd2l0aG91dCBUZWFtQ3JlYXRlLiBjb21wdXRlSW5pdGlhbFRlYW1Db250ZXh0KCkgaXMgZm9yIHRtdXgtc3Bhd25lZFxuICAgICAgICAvLyB0ZWFtbWF0ZXMgcmVhZGluZyB0aGVpciBvd24gaWRlbnRpdHksIG5vdCB0aGUgYXNzaXN0YW50LW1vZGUgbGVhZGVyLlxuICAgICAgICB0ZWFtQ29udGV4dDogZmVhdHVyZSgnS0FJUk9TJylcbiAgICAgICAgICA/IChhc3Npc3RhbnRUZWFtQ29udGV4dCA/PyBjb21wdXRlSW5pdGlhbFRlYW1Db250ZXh0Py4oKSlcbiAgICAgICAgICA6IGNvbXB1dGVJbml0aWFsVGVhbUNvbnRleHQ/LigpLFxuICAgICAgfVxuXG4gICAgICAvLyBBZGQgQ0xJIGluaXRpYWwgcHJvbXB0IHRvIGhpc3RvcnlcbiAgICAgIGlmIChpbnB1dFByb21wdCkge1xuICAgICAgICBhZGRUb0hpc3RvcnkoU3RyaW5nKGlucHV0UHJvbXB0KSlcbiAgICAgIH1cblxuICAgICAgY29uc3QgaW5pdGlhbFRvb2xzID0gbWNwVG9vbHNcblxuICAgICAgLy8gSW5jcmVtZW50IG51bVN0YXJ0dXBzIHN5bmNocm9ub3VzbHkgXHUyMDE0IGZpcnN0LXJlbmRlciByZWFkZXJzIGxpa2VcbiAgICAgIC8vIHNob3VsZFNob3dFZmZvcnRDYWxsb3V0ICh2aWEgdXNlU3RhdGUgaW5pdGlhbGl6ZXIpIG5lZWQgdGhlIHVwZGF0ZWRcbiAgICAgIC8vIHZhbHVlIGJlZm9yZSBzZXRJbW1lZGlhdGUgZmlyZXMuIERlZmVyIG9ubHkgdGVsZW1ldHJ5LlxuICAgICAgc2F2ZUdsb2JhbENvbmZpZyhjdXJyZW50ID0+ICh7XG4gICAgICAgIC4uLmN1cnJlbnQsXG4gICAgICAgIG51bVN0YXJ0dXBzOiAoY3VycmVudC5udW1TdGFydHVwcyA/PyAwKSArIDEsXG4gICAgICB9KSlcbiAgICAgIHNldEltbWVkaWF0ZSgoKSA9PiB7XG4gICAgICAgIHZvaWQgbG9nU3RhcnR1cFRlbGVtZXRyeSgpXG4gICAgICAgIGxvZ1Nlc3Npb25UZWxlbWV0cnkoKVxuICAgICAgfSlcblxuICAgICAgLy8gU2V0IHVwIHBlci10dXJuIHNlc3Npb24gZW52aXJvbm1lbnQgZGF0YSB1cGxvYWRlciAoYW50LW9ubHkgYnVpbGQpLlxuICAgICAgLy8gRGVmYXVsdC1lbmFibGVkIGZvciBhbGwgYW50IHVzZXJzIHdoZW4gd29ya2luZyBpbiBhbiBBbnRocm9waWMtb3duZWRcbiAgICAgIC8vIHJlcG8uIENhcHR1cmVzIGdpdC9maWxlc3lzdGVtIHN0YXRlIChOT1QgdHJhbnNjcmlwdHMpIGF0IGVhY2ggdHVybiBzb1xuICAgICAgLy8gZW52aXJvbm1lbnRzIGNhbiBiZSByZWNyZWF0ZWQgYXQgYW55IHVzZXIgbWVzc2FnZSBpbmRleC4gR2F0aW5nOlxuICAgICAgLy8gICAtIEJ1aWxkLXRpbWU6IHRoaXMgaW1wb3J0IGlzIHN0dWJiZWQgaW4gZXh0ZXJuYWwgYnVpbGRzLlxuICAgICAgLy8gICAtIFJ1bnRpbWU6IHVwbG9hZGVyIGNoZWNrcyBnaXRodWIuY29tL2FudGhyb3BpY3MvKiByZW1vdGUgKyBnY2xvdWQgYXV0aC5cbiAgICAgIC8vICAgLSBTYWZldHk6IENMQVVERV9DT0RFX0RJU0FCTEVfU0VTU0lPTl9EQVRBX1VQTE9BRD0xIGJ5cGFzc2VzICh0ZXN0cyBzZXQgdGhpcykuXG4gICAgICAvLyBJbXBvcnQgaXMgZHluYW1pYyArIGFzeW5jIHRvIGF2b2lkIGFkZGluZyBzdGFydHVwIGxhdGVuY3kuXG4gICAgICBjb25zdCBzZXNzaW9uVXBsb2FkZXJQcm9taXNlID1cbiAgICAgICAgXCJleHRlcm5hbFwiID09PSAnYW50J1xuICAgICAgICAgID8gaW1wb3J0KCcuL3V0aWxzL3Nlc3Npb25EYXRhVXBsb2FkZXIuanMnKVxuICAgICAgICAgIDogbnVsbFxuXG4gICAgICAvLyBEZWZlciBzZXNzaW9uIHVwbG9hZGVyIHJlc29sdXRpb24gdG8gdGhlIG9uVHVybkNvbXBsZXRlIGNhbGxiYWNrIHRvIGF2b2lkXG4gICAgICAvLyBhZGRpbmcgYSBuZXcgdG9wLWxldmVsIGF3YWl0IGluIG1haW4udHN4IChwZXJmb3JtYW5jZS1jcml0aWNhbCBwYXRoKS5cbiAgICAgIC8vIFRoZSBwZXItdHVybiBhdXRoIGxvZ2ljIGluIHNlc3Npb25EYXRhVXBsb2FkZXIudHMgaGFuZGxlcyB1bmF1dGhlbnRpY2F0ZWRcbiAgICAgIC8vIHN0YXRlIGdyYWNlZnVsbHkgKHJlLWNoZWNrcyBlYWNoIHR1cm4sIHNvIGF1dGggcmVjb3ZlcnkgbWlkLXNlc3Npb24gd29ya3MpLlxuICAgICAgY29uc3QgdXBsb2FkZXJSZWFkeSA9IHNlc3Npb25VcGxvYWRlclByb21pc2VcbiAgICAgICAgPyBzZXNzaW9uVXBsb2FkZXJQcm9taXNlXG4gICAgICAgICAgICAudGhlbihtb2QgPT4gbW9kLmNyZWF0ZVNlc3Npb25UdXJuVXBsb2FkZXIoKSlcbiAgICAgICAgICAgIC5jYXRjaCgoKSA9PiBudWxsKVxuICAgICAgICA6IG51bGxcblxuICAgICAgY29uc3Qgc2Vzc2lvbkNvbmZpZyA9IHtcbiAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgIGNvbW1hbmRzOiBbLi4uY29tbWFuZHMsIC4uLm1jcENvbW1hbmRzXSxcbiAgICAgICAgaW5pdGlhbFRvb2xzLFxuICAgICAgICBtY3BDbGllbnRzLFxuICAgICAgICBhdXRvQ29ubmVjdElkZUZsYWc6IGlkZSxcbiAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgZGlzYWJsZVNsYXNoQ29tbWFuZHMsXG4gICAgICAgIGR5bmFtaWNNY3BDb25maWcsXG4gICAgICAgIHN0cmljdE1jcENvbmZpZyxcbiAgICAgICAgc3lzdGVtUHJvbXB0LFxuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHQsXG4gICAgICAgIHRhc2tMaXN0SWQsXG4gICAgICAgIHRoaW5raW5nQ29uZmlnLFxuICAgICAgICAuLi4odXBsb2FkZXJSZWFkeSAmJiB7XG4gICAgICAgICAgb25UdXJuQ29tcGxldGU6IChtZXNzYWdlczogTWVzc2FnZVR5cGVbXSkgPT4ge1xuICAgICAgICAgICAgdm9pZCB1cGxvYWRlclJlYWR5LnRoZW4odXBsb2FkZXIgPT4gdXBsb2FkZXI/LihtZXNzYWdlcykpXG4gICAgICAgICAgfSxcbiAgICAgICAgfSksXG4gICAgICB9XG5cbiAgICAgIC8vIFNoYXJlZCBjb250ZXh0IGZvciBwcm9jZXNzUmVzdW1lZENvbnZlcnNhdGlvbiBjYWxsc1xuICAgICAgY29uc3QgcmVzdW1lQ29udGV4dCA9IHtcbiAgICAgICAgbW9kZUFwaTogY29vcmRpbmF0b3JNb2RlTW9kdWxlLFxuICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICBhZ2VudERlZmluaXRpb25zLFxuICAgICAgICBjdXJyZW50Q3dkLFxuICAgICAgICBjbGlBZ2VudHMsXG4gICAgICAgIGluaXRpYWxTdGF0ZSxcbiAgICAgIH1cblxuICAgICAgaWYgKG9wdGlvbnMuY29udGludWUpIHtcbiAgICAgICAgLy8gQ29udGludWUgdGhlIG1vc3QgcmVjZW50IGNvbnZlcnNhdGlvbiBkaXJlY3RseVxuICAgICAgICBsZXQgcmVzdW1lU3VjY2VlZGVkID0gZmFsc2VcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG5cbiAgICAgICAgICAvLyBDbGVhciBzdGFsZSBjYWNoZXMgYmVmb3JlIHJlc3VtaW5nIHRvIGVuc3VyZSBmcmVzaCBmaWxlL3NraWxsIGRpc2NvdmVyeVxuICAgICAgICAgIGNvbnN0IHsgY2xlYXJTZXNzaW9uQ2FjaGVzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jb21tYW5kcy9jbGVhci9jYWNoZXMuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGNsZWFyU2Vzc2lvbkNhY2hlcygpXG5cbiAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBsb2FkQ29udmVyc2F0aW9uRm9yUmVzdW1lKFxuICAgICAgICAgICAgdW5kZWZpbmVkIC8qIHNlc3Npb25JZCAqLyxcbiAgICAgICAgICAgIHVuZGVmaW5lZCAvKiBzb3VyY2VGaWxlICovLFxuICAgICAgICAgIClcbiAgICAgICAgICBpZiAoIXJlc3VsdCkge1xuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NvbnRpbnVlJywge1xuICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgJ05vIGNvbnZlcnNhdGlvbiBmb3VuZCB0byBjb250aW51ZScsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgbG9hZGVkID0gYXdhaXQgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24oXG4gICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIGZvcmtTZXNzaW9uOiAhIW9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgIGluY2x1ZGVBdHRyaWJ1dGlvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgdHJhbnNjcmlwdFBhdGg6IHJlc3VsdC5mdWxsUGF0aCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICByZXN1bWVDb250ZXh0LFxuICAgICAgICAgIClcblxuICAgICAgICAgIGlmIChsb2FkZWQucmVzdG9yZWRBZ2VudERlZikge1xuICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbiA9IGxvYWRlZC5yZXN0b3JlZEFnZW50RGVmXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbWF5YmVBY3RpdmF0ZVByb2FjdGl2ZShvcHRpb25zKVxuICAgICAgICAgIG1heWJlQWN0aXZhdGVCcmllZihvcHRpb25zKVxuXG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2NvbnRpbnVlJywge1xuICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgIHJlc3VtZV9kdXJhdGlvbl9tczogTWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0KSxcbiAgICAgICAgICB9KVxuICAgICAgICAgIHJlc3VtZVN1Y2NlZWRlZCA9IHRydWVcblxuICAgICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlOiBsb2FkZWQuaW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLnNlc3Npb25Db25maWcsXG4gICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb246XG4gICAgICAgICAgICAgICAgbG9hZGVkLnJlc3RvcmVkQWdlbnREZWYgPz8gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBsb2FkZWQubWVzc2FnZXMsXG4gICAgICAgICAgICAgIGluaXRpYWxGaWxlSGlzdG9yeVNuYXBzaG90czogbG9hZGVkLmZpbGVIaXN0b3J5U25hcHNob3RzLFxuICAgICAgICAgICAgICBpbml0aWFsQ29udGVudFJlcGxhY2VtZW50czogbG9hZGVkLmNvbnRlbnRSZXBsYWNlbWVudHMsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudE5hbWU6IGxvYWRlZC5hZ2VudE5hbWUsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudENvbG9yOiBsb2FkZWQuYWdlbnRDb2xvcixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgICAgKVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIGlmICghcmVzdW1lU3VjY2VlZGVkKSB7XG4gICAgICAgICAgICBsb2dFdmVudCgndGVuZ3VfY29udGludWUnLCB7XG4gICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICB9XG4gICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZmVhdHVyZSgnRElSRUNUX0NPTk5FQ1QnKSAmJiBfcGVuZGluZ0Nvbm5lY3Q/LnVybCkge1xuICAgICAgICAvLyBgY2xhdWRlIGNvbm5lY3QgPHVybD5gIFx1MjAxNCBmdWxsIGludGVyYWN0aXZlIFRVSSBjb25uZWN0ZWQgdG8gYSByZW1vdGUgc2VydmVyXG4gICAgICAgIGxldCBkaXJlY3RDb25uZWN0Q29uZmlnXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZURpcmVjdENvbm5lY3RTZXNzaW9uKHtcbiAgICAgICAgICAgIHNlcnZlclVybDogX3BlbmRpbmdDb25uZWN0LnVybCxcbiAgICAgICAgICAgIGF1dGhUb2tlbjogX3BlbmRpbmdDb25uZWN0LmF1dGhUb2tlbixcbiAgICAgICAgICAgIGN3ZDogZ2V0T3JpZ2luYWxDd2QoKSxcbiAgICAgICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOlxuICAgICAgICAgICAgICBfcGVuZGluZ0Nvbm5lY3QuZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnMsXG4gICAgICAgICAgfSlcbiAgICAgICAgICBpZiAoc2Vzc2lvbi53b3JrRGlyKSB7XG4gICAgICAgICAgICBzZXRPcmlnaW5hbEN3ZChzZXNzaW9uLndvcmtEaXIpXG4gICAgICAgICAgICBzZXRDd2RTdGF0ZShzZXNzaW9uLndvcmtEaXIpXG4gICAgICAgICAgfVxuICAgICAgICAgIHNldERpcmVjdENvbm5lY3RTZXJ2ZXJVcmwoX3BlbmRpbmdDb25uZWN0LnVybClcbiAgICAgICAgICBkaXJlY3RDb25uZWN0Q29uZmlnID0gc2Vzc2lvbi5jb25maWdcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgZXJyIGluc3RhbmNlb2YgRGlyZWN0Q29ubmVjdEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgKVxuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgY29ubmVjdEluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBgQ29ubmVjdGVkIHRvIHNlcnZlciBhdCAke19wZW5kaW5nQ29ubmVjdC51cmx9XFxuU2Vzc2lvbjogJHtkaXJlY3RDb25uZWN0Q29uZmlnLnNlc3Npb25JZH1gLFxuICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgKVxuXG4gICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkZWJ1ZzogZGVidWcgfHwgZGVidWdUb1N0ZGVycixcbiAgICAgICAgICAgIGNvbW1hbmRzLFxuICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlczogW2Nvbm5lY3RJbmZvTWVzc2FnZV0sXG4gICAgICAgICAgICBtY3BDbGllbnRzOiBbXSxcbiAgICAgICAgICAgIGF1dG9Db25uZWN0SWRlRmxhZzogaWRlLFxuICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgIGRpc2FibGVTbGFzaENvbW1hbmRzLFxuICAgICAgICAgICAgZGlyZWN0Q29ubmVjdENvbmZpZyxcbiAgICAgICAgICAgIHRoaW5raW5nQ29uZmlnLFxuICAgICAgICAgIH0sXG4gICAgICAgICAgcmVuZGVyQW5kUnVuLFxuICAgICAgICApXG4gICAgICAgIHJldHVyblxuICAgICAgfSBlbHNlIGlmIChmZWF0dXJlKCdTU0hfUkVNT1RFJykgJiYgX3BlbmRpbmdTU0g/Lmhvc3QpIHtcbiAgICAgICAgLy8gYGNsYXVkZSBzc2ggPGhvc3Q+IFtkaXJdYCBcdTIwMTQgcHJvYmUgcmVtb3RlLCBkZXBsb3kgYmluYXJ5IGlmIG5lZWRlZCxcbiAgICAgICAgLy8gc3Bhd24gc3NoIHdpdGggdW5peC1zb2NrZXQgLVIgZm9yd2FyZCB0byBhIGxvY2FsIGF1dGggcHJveHksIGhhbmRcbiAgICAgICAgLy8gdGhlIFJFUEwgYW4gU1NIU2Vzc2lvbi4gVG9vbHMgcnVuIHJlbW90ZWx5LCBVSSByZW5kZXJzIGxvY2FsbHkuXG4gICAgICAgIC8vIGAtLWxvY2FsYCBza2lwcyBwcm9iZS9kZXBsb3kvc3NoIGFuZCBzcGF3bnMgdGhlIGN1cnJlbnQgYmluYXJ5XG4gICAgICAgIC8vIGRpcmVjdGx5IHdpdGggdGhlIHNhbWUgZW52IFx1MjAxNCBlMmUgdGVzdCBvZiB0aGUgcHJveHkvYXV0aCBwbHVtYmluZy5cbiAgICAgICAgY29uc3QgeyBjcmVhdGVTU0hTZXNzaW9uLCBjcmVhdGVMb2NhbFNTSFNlc3Npb24sIFNTSFNlc3Npb25FcnJvciB9ID1cbiAgICAgICAgICBhd2FpdCBpbXBvcnQoJy4vc3NoL2NyZWF0ZVNTSFNlc3Npb24uanMnKVxuICAgICAgICBsZXQgc3NoU2Vzc2lvblxuICAgICAgICB0cnkge1xuICAgICAgICAgIGlmIChfcGVuZGluZ1NTSC5sb2NhbCkge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoJ1N0YXJ0aW5nIGxvY2FsIHNzaC1wcm94eSB0ZXN0IHNlc3Npb24uLi5cXG4nKVxuICAgICAgICAgICAgc3NoU2Vzc2lvbiA9IGNyZWF0ZUxvY2FsU1NIU2Vzc2lvbih7XG4gICAgICAgICAgICAgIGN3ZDogX3BlbmRpbmdTU0guY3dkLFxuICAgICAgICAgICAgICBwZXJtaXNzaW9uTW9kZTogX3BlbmRpbmdTU0gucGVybWlzc2lvbk1vZGUsXG4gICAgICAgICAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zOlxuICAgICAgICAgICAgICAgIF9wZW5kaW5nU1NILmRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgfSlcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoYENvbm5lY3RpbmcgdG8gJHtfcGVuZGluZ1NTSC5ob3N0fVx1MjAyNlxcbmApXG4gICAgICAgICAgICAvLyBJbi1wbGFjZSBwcm9ncmVzczogXFxyICsgRUwwIChlcmFzZSB0byBlbmQgb2YgbGluZSkuIEZpbmFsIFxcbiBvblxuICAgICAgICAgICAgLy8gc3VjY2VzcyBzbyB0aGUgbmV4dCBtZXNzYWdlIGxhbmRzIG9uIGEgZnJlc2ggbGluZS4gTm8tb3Agd2hlblxuICAgICAgICAgICAgLy8gc3RkZXJyIGlzbid0IGEgVFRZIChwaXBlZC9yZWRpcmVjdGVkKSBcdTIwMTQgXFxyIHdvdWxkIGp1c3QgZW1pdCBub2lzZS5cbiAgICAgICAgICAgIGNvbnN0IGlzVFRZID0gcHJvY2Vzcy5zdGRlcnIuaXNUVFlcbiAgICAgICAgICAgIGxldCBoYWRQcm9ncmVzcyA9IGZhbHNlXG4gICAgICAgICAgICBzc2hTZXNzaW9uID0gYXdhaXQgY3JlYXRlU1NIU2Vzc2lvbihcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIGhvc3Q6IF9wZW5kaW5nU1NILmhvc3QsXG4gICAgICAgICAgICAgICAgY3dkOiBfcGVuZGluZ1NTSC5jd2QsXG4gICAgICAgICAgICAgICAgbG9jYWxWZXJzaW9uOiBNQUNSTy5WRVJTSU9OLFxuICAgICAgICAgICAgICAgIHBlcm1pc3Npb25Nb2RlOiBfcGVuZGluZ1NTSC5wZXJtaXNzaW9uTW9kZSxcbiAgICAgICAgICAgICAgICBkYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uczpcbiAgICAgICAgICAgICAgICAgIF9wZW5kaW5nU1NILmRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zLFxuICAgICAgICAgICAgICAgIGV4dHJhQ2xpQXJnczogX3BlbmRpbmdTU0guZXh0cmFDbGlBcmdzLFxuICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICBpc1RUWVxuICAgICAgICAgICAgICAgID8ge1xuICAgICAgICAgICAgICAgICAgICBvblByb2dyZXNzOiBtc2cgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgIGhhZFByb2dyZXNzID0gdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3Muc3RkZXJyLndyaXRlKGBcXHIgICR7bXNnfVxceDFiW0tgKVxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIDoge30sXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBpZiAoaGFkUHJvZ3Jlc3MpIHByb2Nlc3Muc3RkZXJyLndyaXRlKCdcXG4nKVxuICAgICAgICAgIH1cbiAgICAgICAgICBzZXRPcmlnaW5hbEN3ZChzc2hTZXNzaW9uLnJlbW90ZUN3ZClcbiAgICAgICAgICBzZXRDd2RTdGF0ZShzc2hTZXNzaW9uLnJlbW90ZUN3ZClcbiAgICAgICAgICBzZXREaXJlY3RDb25uZWN0U2VydmVyVXJsKFxuICAgICAgICAgICAgX3BlbmRpbmdTU0gubG9jYWwgPyAnbG9jYWwnIDogX3BlbmRpbmdTU0guaG9zdCxcbiAgICAgICAgICApXG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgIGVyciBpbnN0YW5jZW9mIFNTSFNlc3Npb25FcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHNzaEluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBfcGVuZGluZ1NTSC5sb2NhbFxuICAgICAgICAgICAgPyBgTG9jYWwgc3NoLXByb3h5IHRlc3Qgc2Vzc2lvblxcbmN3ZDogJHtzc2hTZXNzaW9uLnJlbW90ZUN3ZH1cXG5BdXRoOiB1bml4IHNvY2tldCBcdTIxOTIgbG9jYWwgcHJveHlgXG4gICAgICAgICAgICA6IGBTU0ggc2Vzc2lvbiB0byAke19wZW5kaW5nU1NILmhvc3R9XFxuUmVtb3RlIGN3ZDogJHtzc2hTZXNzaW9uLnJlbW90ZUN3ZH1cXG5BdXRoOiB1bml4IHNvY2tldCAtUiBcdTIxOTIgbG9jYWwgcHJveHlgLFxuICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgKVxuXG4gICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgcm9vdCxcbiAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICB7XG4gICAgICAgICAgICBkZWJ1ZzogZGVidWcgfHwgZGVidWdUb1N0ZGVycixcbiAgICAgICAgICAgIGNvbW1hbmRzLFxuICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlczogW3NzaEluZm9NZXNzYWdlXSxcbiAgICAgICAgICAgIG1jcENsaWVudHM6IFtdLFxuICAgICAgICAgICAgYXV0b0Nvbm5lY3RJZGVGbGFnOiBpZGUsXG4gICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICAgICAgZGlzYWJsZVNsYXNoQ29tbWFuZHMsXG4gICAgICAgICAgICBzc2hTZXNzaW9uLFxuICAgICAgICAgICAgdGhpbmtpbmdDb25maWcsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgIClcbiAgICAgICAgcmV0dXJuXG4gICAgICB9IGVsc2UgaWYgKFxuICAgICAgICBmZWF0dXJlKCdLQUlST1MnKSAmJlxuICAgICAgICBfcGVuZGluZ0Fzc2lzdGFudENoYXQgJiZcbiAgICAgICAgKF9wZW5kaW5nQXNzaXN0YW50Q2hhdC5zZXNzaW9uSWQgfHwgX3BlbmRpbmdBc3Npc3RhbnRDaGF0LmRpc2NvdmVyKVxuICAgICAgKSB7XG4gICAgICAgIC8vIGBjbGF1ZGUgYXNzaXN0YW50IFtzZXNzaW9uSWRdYCBcdTIwMTQgUkVQTCBhcyBhIHB1cmUgdmlld2VyIGNsaWVudFxuICAgICAgICAvLyBvZiBhIHJlbW90ZSBhc3Npc3RhbnQgc2Vzc2lvbi4gVGhlIGFnZW50aWMgbG9vcCBydW5zIHJlbW90ZWx5OyB0aGlzXG4gICAgICAgIC8vIHByb2Nlc3Mgc3RyZWFtcyBsaXZlIGV2ZW50cyBhbmQgUE9TVHMgbWVzc2FnZXMuIEhpc3RvcnkgaXMgbGF6eS1cbiAgICAgICAgLy8gbG9hZGVkIGJ5IHVzZUFzc2lzdGFudEhpc3Rvcnkgb24gc2Nyb2xsLXVwIChubyBibG9ja2luZyBmZXRjaCBoZXJlKS5cbiAgICAgICAgY29uc3QgeyBkaXNjb3ZlckFzc2lzdGFudFNlc3Npb25zIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vYXNzaXN0YW50L3Nlc3Npb25EaXNjb3ZlcnkuanMnXG4gICAgICAgIClcblxuICAgICAgICBsZXQgdGFyZ2V0U2Vzc2lvbklkID0gX3BlbmRpbmdBc3Npc3RhbnRDaGF0LnNlc3Npb25JZFxuXG4gICAgICAgIC8vIERpc2NvdmVyeSBmbG93IFx1MjAxNCBsaXN0IGJyaWRnZSBlbnZpcm9ubWVudHMsIGZpbHRlciBzZXNzaW9uc1xuICAgICAgICBpZiAoIXRhcmdldFNlc3Npb25JZCkge1xuICAgICAgICAgIGxldCBzZXNzaW9uc1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBzZXNzaW9ucyA9IGF3YWl0IGRpc2NvdmVyQXNzaXN0YW50U2Vzc2lvbnMoKVxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICBgRmFpbGVkIHRvIGRpc2NvdmVyIHNlc3Npb25zOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6IGV9YCxcbiAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHNlc3Npb25zLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgbGV0IGluc3RhbGxlZERpcjogc3RyaW5nIHwgbnVsbFxuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgaW5zdGFsbGVkRGlyID0gYXdhaXQgbGF1bmNoQXNzaXN0YW50SW5zdGFsbFdpemFyZChyb290KVxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICAgIGBBc3Npc3RhbnQgaW5zdGFsbGF0aW9uIGZhaWxlZDogJHtlIGluc3RhbmNlb2YgRXJyb3IgPyBlLm1lc3NhZ2UgOiBlfWAsXG4gICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGluc3RhbGxlZERpciA9PT0gbnVsbCkge1xuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLy8gVGhlIGRhZW1vbiBuZWVkcyBhIGZldyBzZWNvbmRzIHRvIHNwaW4gdXAgaXRzIHdvcmtlciBhbmRcbiAgICAgICAgICAgIC8vIGVzdGFibGlzaCBhIGJyaWRnZSBzZXNzaW9uIGJlZm9yZSBkaXNjb3Zlcnkgd2lsbCBmaW5kIGl0LlxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoTWVzc2FnZShcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgYEFzc2lzdGFudCBpbnN0YWxsZWQgaW4gJHtpbnN0YWxsZWREaXJ9LiBUaGUgZGFlbW9uIGlzIHN0YXJ0aW5nIHVwIFx1MjAxNCBydW4gXFxgY2xhdWRlIGFzc2lzdGFudFxcYCBhZ2FpbiBpbiBhIGZldyBzZWNvbmRzIHRvIGNvbm5lY3QuYCxcbiAgICAgICAgICAgICAgeyBleGl0Q29kZTogMCwgYmVmb3JlRXhpdDogKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigwKSB9LFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgICBpZiAoc2Vzc2lvbnMubGVuZ3RoID09PSAxKSB7XG4gICAgICAgICAgICB0YXJnZXRTZXNzaW9uSWQgPSBzZXNzaW9uc1swXSEuaWRcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3QgcGlja2VkID0gYXdhaXQgbGF1bmNoQXNzaXN0YW50U2Vzc2lvbkNob29zZXIocm9vdCwge1xuICAgICAgICAgICAgICBzZXNzaW9ucyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAoIXBpY2tlZCkge1xuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGFyZ2V0U2Vzc2lvbklkID0gcGlja2VkXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gQXV0aCBcdTIwMTQgY2FsbCBwcmVwYXJlQXBpUmVxdWVzdCgpIG9uY2UgZm9yIG9yZ1VVSUQsIGJ1dCB1c2UgYVxuICAgICAgICAvLyBnZXRBY2Nlc3NUb2tlbiBjbG9zdXJlIGZvciB0aGUgdG9rZW4gc28gcmVjb25uZWN0cyBnZXQgZnJlc2ggdG9rZW5zLlxuICAgICAgICBjb25zdCB7IGNoZWNrQW5kUmVmcmVzaE9BdXRoVG9rZW5JZk5lZWRlZCwgZ2V0Q2xhdWRlQUlPQXV0aFRva2VucyB9ID1cbiAgICAgICAgICBhd2FpdCBpbXBvcnQoJy4vdXRpbHMvYXV0aC5qcycpXG4gICAgICAgIGF3YWl0IGNoZWNrQW5kUmVmcmVzaE9BdXRoVG9rZW5JZk5lZWRlZCgpXG4gICAgICAgIGxldCBhcGlDcmVkc1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGFwaUNyZWRzID0gYXdhaXQgcHJlcGFyZUFwaVJlcXVlc3QoKVxuICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgYEVycm9yOiAke2UgaW5zdGFuY2VvZiBFcnJvciA/IGUubWVzc2FnZSA6ICdGYWlsZWQgdG8gYXV0aGVudGljYXRlJ31gLFxuICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICApXG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZ2V0QWNjZXNzVG9rZW4gPSAoKTogc3RyaW5nID0+XG4gICAgICAgICAgZ2V0Q2xhdWRlQUlPQXV0aFRva2VucygpPy5hY2Nlc3NUb2tlbiA/PyBhcGlDcmVkcy5hY2Nlc3NUb2tlblxuXG4gICAgICAgIC8vIEJyaWVmIG1vZGUgYWN0aXZhdGlvbjogc2V0S2Fpcm9zQWN0aXZlKHRydWUpIHNhdGlzZmllcyBCT1RIIG9wdC1pblxuICAgICAgICAvLyBhbmQgZW50aXRsZW1lbnQgZm9yIGlzQnJpZWZFbmFibGVkKCkgKEJyaWVmVG9vbC50czoxMjQtMTMyKS5cbiAgICAgICAgc2V0S2Fpcm9zQWN0aXZlKHRydWUpXG4gICAgICAgIHNldFVzZXJNc2dPcHRJbih0cnVlKVxuICAgICAgICBzZXRJc1JlbW90ZU1vZGUodHJ1ZSlcblxuICAgICAgICBjb25zdCByZW1vdGVTZXNzaW9uQ29uZmlnID0gY3JlYXRlUmVtb3RlU2Vzc2lvbkNvbmZpZyhcbiAgICAgICAgICB0YXJnZXRTZXNzaW9uSWQsXG4gICAgICAgICAgZ2V0QWNjZXNzVG9rZW4sXG4gICAgICAgICAgYXBpQ3JlZHMub3JnVVVJRCxcbiAgICAgICAgICAvKiBoYXNJbml0aWFsUHJvbXB0ICovIGZhbHNlLFxuICAgICAgICAgIC8qIHZpZXdlck9ubHkgKi8gdHJ1ZSxcbiAgICAgICAgKVxuXG4gICAgICAgIGNvbnN0IGluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICBgQXR0YWNoZWQgdG8gYXNzaXN0YW50IHNlc3Npb24gJHt0YXJnZXRTZXNzaW9uSWQuc2xpY2UoMCwgOCl9XHUyMDI2YCxcbiAgICAgICAgICAnaW5mbycsXG4gICAgICAgIClcblxuICAgICAgICBjb25zdCBhc3Npc3RhbnRJbml0aWFsU3RhdGU6IEFwcFN0YXRlID0ge1xuICAgICAgICAgIC4uLmluaXRpYWxTdGF0ZSxcbiAgICAgICAgICBpc0JyaWVmT25seTogdHJ1ZSxcbiAgICAgICAgICBrYWlyb3NFbmFibGVkOiBmYWxzZSxcbiAgICAgICAgICByZXBsQnJpZGdlRW5hYmxlZDogZmFsc2UsXG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZW1vdGVDb21tYW5kcyA9IGZpbHRlckNvbW1hbmRzRm9yUmVtb3RlTW9kZShjb21tYW5kcylcbiAgICAgICAgYXdhaXQgbGF1bmNoUmVwbChcbiAgICAgICAgICByb290LFxuICAgICAgICAgIHsgZ2V0RnBzTWV0cmljcywgc3RhdHMsIGluaXRpYWxTdGF0ZTogYXNzaXN0YW50SW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgICAgICBjb21tYW5kczogcmVtb3RlQ29tbWFuZHMsXG4gICAgICAgICAgICBpbml0aWFsVG9vbHM6IFtdLFxuICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBbaW5mb01lc3NhZ2VdLFxuICAgICAgICAgICAgbWNwQ2xpZW50czogW10sXG4gICAgICAgICAgICBhdXRvQ29ubmVjdElkZUZsYWc6IGlkZSxcbiAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24sXG4gICAgICAgICAgICBkaXNhYmxlU2xhc2hDb21tYW5kcyxcbiAgICAgICAgICAgIHJlbW90ZVNlc3Npb25Db25maWcsXG4gICAgICAgICAgICB0aGlua2luZ0NvbmZpZyxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHJlbmRlckFuZFJ1bixcbiAgICAgICAgKVxuICAgICAgICByZXR1cm5cbiAgICAgIH0gZWxzZSBpZiAoXG4gICAgICAgIG9wdGlvbnMucmVzdW1lIHx8XG4gICAgICAgIG9wdGlvbnMuZnJvbVByIHx8XG4gICAgICAgIHRlbGVwb3J0IHx8XG4gICAgICAgIHJlbW90ZSAhPT0gbnVsbFxuICAgICAgKSB7XG4gICAgICAgIC8vIEhhbmRsZSByZXN1bWUgZmxvdyAtIGZyb20gZmlsZSAoYW50LW9ubHkpLCBzZXNzaW9uIElELCBvciBpbnRlcmFjdGl2ZSBzZWxlY3RvclxuXG4gICAgICAgIC8vIENsZWFyIHN0YWxlIGNhY2hlcyBiZWZvcmUgcmVzdW1pbmcgdG8gZW5zdXJlIGZyZXNoIGZpbGUvc2tpbGwgZGlzY292ZXJ5XG4gICAgICAgIGNvbnN0IHsgY2xlYXJTZXNzaW9uQ2FjaGVzIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY29tbWFuZHMvY2xlYXIvY2FjaGVzLmpzJ1xuICAgICAgICApXG4gICAgICAgIGNsZWFyU2Vzc2lvbkNhY2hlcygpXG5cbiAgICAgICAgbGV0IG1lc3NhZ2VzOiBNZXNzYWdlVHlwZVtdIHwgbnVsbCA9IG51bGxcbiAgICAgICAgbGV0IHByb2Nlc3NlZFJlc3VtZTogUHJvY2Vzc2VkUmVzdW1lIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkXG5cbiAgICAgICAgbGV0IG1heWJlU2Vzc2lvbklkID0gdmFsaWRhdGVVdWlkKG9wdGlvbnMucmVzdW1lKVxuICAgICAgICBsZXQgc2VhcmNoVGVybTogc3RyaW5nIHwgdW5kZWZpbmVkID0gdW5kZWZpbmVkXG4gICAgICAgIC8vIFN0b3JlIGZ1bGwgTG9nT3B0aW9uIHdoZW4gZm91bmQgYnkgY3VzdG9tIHRpdGxlIChmb3IgY3Jvc3Mtd29ya3RyZWUgcmVzdW1lKVxuICAgICAgICBsZXQgbWF0Y2hlZExvZzogTG9nT3B0aW9uIHwgbnVsbCA9IG51bGxcbiAgICAgICAgLy8gUFIgZmlsdGVyIGZvciAtLWZyb20tcHIgZmxhZ1xuICAgICAgICBsZXQgZmlsdGVyQnlQcjogYm9vbGVhbiB8IG51bWJlciB8IHN0cmluZyB8IHVuZGVmaW5lZCA9IHVuZGVmaW5lZFxuXG4gICAgICAgIC8vIEhhbmRsZSAtLWZyb20tcHIgZmxhZ1xuICAgICAgICBpZiAob3B0aW9ucy5mcm9tUHIpIHtcbiAgICAgICAgICBpZiAob3B0aW9ucy5mcm9tUHIgPT09IHRydWUpIHtcbiAgICAgICAgICAgIC8vIFNob3cgYWxsIHNlc3Npb25zIHdpdGggbGlua2VkIFBSc1xuICAgICAgICAgICAgZmlsdGVyQnlQciA9IHRydWVcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBvcHRpb25zLmZyb21QciA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIC8vIENvdWxkIGJlIGEgUFIgbnVtYmVyIG9yIFVSTFxuICAgICAgICAgICAgZmlsdGVyQnlQciA9IG9wdGlvbnMuZnJvbVByXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy8gSWYgcmVzdW1lIHZhbHVlIGlzIG5vdCBhIFVVSUQsIHRyeSBleGFjdCBtYXRjaCBieSBjdXN0b20gdGl0bGUgZmlyc3RcbiAgICAgICAgaWYgKFxuICAgICAgICAgIG9wdGlvbnMucmVzdW1lICYmXG4gICAgICAgICAgdHlwZW9mIG9wdGlvbnMucmVzdW1lID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAgICFtYXliZVNlc3Npb25JZFxuICAgICAgICApIHtcbiAgICAgICAgICBjb25zdCB0cmltbWVkVmFsdWUgPSBvcHRpb25zLnJlc3VtZS50cmltKClcbiAgICAgICAgICBpZiAodHJpbW1lZFZhbHVlKSB7XG4gICAgICAgICAgICBjb25zdCBtYXRjaGVzID0gYXdhaXQgc2VhcmNoU2Vzc2lvbnNCeUN1c3RvbVRpdGxlKHRyaW1tZWRWYWx1ZSwge1xuICAgICAgICAgICAgICBleGFjdDogdHJ1ZSxcbiAgICAgICAgICAgIH0pXG5cbiAgICAgICAgICAgIGlmIChtYXRjaGVzLmxlbmd0aCA9PT0gMSkge1xuICAgICAgICAgICAgICAvLyBFeGFjdCBtYXRjaCBmb3VuZCAtIHN0b3JlIGZ1bGwgTG9nT3B0aW9uIGZvciBjcm9zcy13b3JrdHJlZSByZXN1bWVcbiAgICAgICAgICAgICAgbWF0Y2hlZExvZyA9IG1hdGNoZXNbMF0hXG4gICAgICAgICAgICAgIG1heWJlU2Vzc2lvbklkID0gZ2V0U2Vzc2lvbklkRnJvbUxvZyhtYXRjaGVkTG9nKSA/PyBudWxsXG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAvLyBObyBtYXRjaCBvciBtdWx0aXBsZSBtYXRjaGVzIC0gdXNlIGFzIHNlYXJjaCB0ZXJtIGZvciBwaWNrZXJcbiAgICAgICAgICAgICAgc2VhcmNoVGVybSA9IHRyaW1tZWRWYWx1ZVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIC0tcmVtb3RlIGFuZCAtLXRlbGVwb3J0IGJvdGggY3JlYXRlL3Jlc3VtZSBDbGF1ZGUgQ29kZSBXZWIgKENDUikgc2Vzc2lvbnMuXG4gICAgICAgIC8vIFJlbW90ZSBDb250cm9sICgtLXJjKSBpcyBhIHNlcGFyYXRlIGZlYXR1cmUgZ2F0ZWQgaW4gaW5pdFJlcGxCcmlkZ2UudHMuXG4gICAgICAgIGlmIChyZW1vdGUgIT09IG51bGwgfHwgdGVsZXBvcnQpIHtcbiAgICAgICAgICBhd2FpdCB3YWl0Rm9yUG9saWN5TGltaXRzVG9Mb2FkKClcbiAgICAgICAgICBpZiAoIWlzUG9saWN5QWxsb3dlZCgnYWxsb3dfcmVtb3RlX3Nlc3Npb25zJykpIHtcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICBcIkVycm9yOiBSZW1vdGUgc2Vzc2lvbnMgYXJlIGRpc2FibGVkIGJ5IHlvdXIgb3JnYW5pemF0aW9uJ3MgcG9saWN5LlwiLFxuICAgICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZW1vdGUgIT09IG51bGwpIHtcbiAgICAgICAgICAvLyBDcmVhdGUgcmVtb3RlIHNlc3Npb24gKG9wdGlvbmFsbHkgd2l0aCBpbml0aWFsIHByb21wdClcbiAgICAgICAgICBjb25zdCBoYXNJbml0aWFsUHJvbXB0ID0gcmVtb3RlLmxlbmd0aCA+IDBcblxuICAgICAgICAgIC8vIENoZWNrIGlmIFRVSSBtb2RlIGlzIGVuYWJsZWQgLSBkZXNjcmlwdGlvbiBpcyBvbmx5IG9wdGlvbmFsIGluIFRVSSBtb2RlXG4gICAgICAgICAgY29uc3QgaXNSZW1vdGVUdWlFbmFibGVkID0gZ2V0RmVhdHVyZVZhbHVlX0NBQ0hFRF9NQVlfQkVfU1RBTEUoXG4gICAgICAgICAgICAndGVuZ3VfcmVtb3RlX2JhY2tlbmQnLFxuICAgICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmICghaXNSZW1vdGVUdWlFbmFibGVkICYmICFoYXNJbml0aWFsUHJvbXB0KSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgJ0Vycm9yOiAtLXJlbW90ZSByZXF1aXJlcyBhIGRlc2NyaXB0aW9uLlxcblVzYWdlOiBjbGF1ZGUgLS1yZW1vdGUgXCJ5b3VyIHRhc2sgZGVzY3JpcHRpb25cIicsXG4gICAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3JlbW90ZV9jcmVhdGVfc2Vzc2lvbicsIHtcbiAgICAgICAgICAgIGhhc19pbml0aWFsX3Byb21wdDogU3RyaW5nKFxuICAgICAgICAgICAgICBoYXNJbml0aWFsUHJvbXB0LFxuICAgICAgICAgICAgKSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICAvLyBQYXNzIGN1cnJlbnQgYnJhbmNoIHNvIENDUiBjbG9uZXMgdGhlIHJlcG8gYXQgdGhlIHJpZ2h0IHJldmlzaW9uXG4gICAgICAgICAgY29uc3QgY3VycmVudEJyYW5jaCA9IGF3YWl0IGdldEJyYW5jaCgpXG4gICAgICAgICAgY29uc3QgY3JlYXRlZFNlc3Npb24gPSBhd2FpdCB0ZWxlcG9ydFRvUmVtb3RlV2l0aEVycm9ySGFuZGxpbmcoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgaGFzSW5pdGlhbFByb21wdCA/IHJlbW90ZSA6IG51bGwsXG4gICAgICAgICAgICBuZXcgQWJvcnRDb250cm9sbGVyKCkuc2lnbmFsLFxuICAgICAgICAgICAgY3VycmVudEJyYW5jaCB8fCB1bmRlZmluZWQsXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmICghY3JlYXRlZFNlc3Npb24pIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9yZW1vdGVfY3JlYXRlX3Nlc3Npb25fZXJyb3InLCB7XG4gICAgICAgICAgICAgIGVycm9yOlxuICAgICAgICAgICAgICAgICd1bmFibGVfdG9fY3JlYXRlX3Nlc3Npb24nIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICB9KVxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICdFcnJvcjogVW5hYmxlIHRvIGNyZWF0ZSByZW1vdGUgc2Vzc2lvbicsXG4gICAgICAgICAgICAgICgpID0+IGdyYWNlZnVsU2h1dGRvd24oMSksXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9yZW1vdGVfY3JlYXRlX3Nlc3Npb25fc3VjY2VzcycsIHtcbiAgICAgICAgICAgIHNlc3Npb25faWQ6XG4gICAgICAgICAgICAgIGNyZWF0ZWRTZXNzaW9uLmlkIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgfSlcblxuICAgICAgICAgIC8vIENoZWNrIGlmIG5ldyByZW1vdGUgVFVJIG1vZGUgaXMgZW5hYmxlZCB2aWEgZmVhdHVyZSBnYXRlXG4gICAgICAgICAgaWYgKCFpc1JlbW90ZVR1aUVuYWJsZWQpIHtcbiAgICAgICAgICAgIC8vIE9yaWdpbmFsIGJlaGF2aW9yOiBwcmludCBzZXNzaW9uIGluZm8gYW5kIGV4aXRcbiAgICAgICAgICAgIHByb2Nlc3Muc3Rkb3V0LndyaXRlKFxuICAgICAgICAgICAgICBgQ3JlYXRlZCByZW1vdGUgc2Vzc2lvbjogJHtjcmVhdGVkU2Vzc2lvbi50aXRsZX1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICAgIGBWaWV3OiAke2dldFJlbW90ZVNlc3Npb25VcmwoY3JlYXRlZFNlc3Npb24uaWQpfT9tPTBcXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5zdGRvdXQud3JpdGUoXG4gICAgICAgICAgICAgIGBSZXN1bWUgd2l0aDogY2xhdWRlIC0tdGVsZXBvcnQgJHtjcmVhdGVkU2Vzc2lvbi5pZH1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgYXdhaXQgZ3JhY2VmdWxTaHV0ZG93bigwKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gTmV3IGJlaGF2aW9yOiBzdGFydCBsb2NhbCBUVUkgd2l0aCBDQ1IgZW5naW5lXG4gICAgICAgICAgLy8gTWFyayB0aGF0IHdlJ3JlIGluIHJlbW90ZSBtb2RlIGZvciBjb21tYW5kIHZpc2liaWxpdHlcbiAgICAgICAgICBzZXRJc1JlbW90ZU1vZGUodHJ1ZSlcbiAgICAgICAgICBzd2l0Y2hTZXNzaW9uKGFzU2Vzc2lvbklkKGNyZWF0ZWRTZXNzaW9uLmlkKSlcblxuICAgICAgICAgIC8vIEdldCBPQXV0aCBjcmVkZW50aWFscyBmb3IgcmVtb3RlIHNlc3Npb25cbiAgICAgICAgICBsZXQgYXBpQ3JlZHM6IHsgYWNjZXNzVG9rZW46IHN0cmluZzsgb3JnVVVJRDogc3RyaW5nIH1cbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXBpQ3JlZHMgPSBhd2FpdCBwcmVwYXJlQXBpUmVxdWVzdCgpXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxvZ0Vycm9yKHRvRXJyb3IoZXJyb3IpKVxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGV4aXRXaXRoRXJyb3IoXG4gICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgIGBFcnJvcjogJHtlcnJvck1lc3NhZ2UoZXJyb3IpIHx8ICdGYWlsZWQgdG8gYXV0aGVudGljYXRlJ31gLFxuICAgICAgICAgICAgICAoKSA9PiBncmFjZWZ1bFNodXRkb3duKDEpLFxuICAgICAgICAgICAgKVxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIENyZWF0ZSByZW1vdGUgc2Vzc2lvbiBjb25maWcgZm9yIHRoZSBSRVBMXG4gICAgICAgICAgY29uc3QgeyBnZXRDbGF1ZGVBSU9BdXRoVG9rZW5zOiBnZXRUb2tlbnNGb3JSZW1vdGUgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICcuL3V0aWxzL2F1dGguanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGNvbnN0IGdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlID0gKCk6IHN0cmluZyA9PlxuICAgICAgICAgICAgZ2V0VG9rZW5zRm9yUmVtb3RlKCk/LmFjY2Vzc1Rva2VuID8/IGFwaUNyZWRzLmFjY2Vzc1Rva2VuXG4gICAgICAgICAgY29uc3QgcmVtb3RlU2Vzc2lvbkNvbmZpZyA9IGNyZWF0ZVJlbW90ZVNlc3Npb25Db25maWcoXG4gICAgICAgICAgICBjcmVhdGVkU2Vzc2lvbi5pZCxcbiAgICAgICAgICAgIGdldEFjY2Vzc1Rva2VuRm9yUmVtb3RlLFxuICAgICAgICAgICAgYXBpQ3JlZHMub3JnVVVJRCxcbiAgICAgICAgICAgIGhhc0luaXRpYWxQcm9tcHQsXG4gICAgICAgICAgKVxuXG4gICAgICAgICAgLy8gQWRkIHJlbW90ZSBzZXNzaW9uIGluZm8gYXMgaW5pdGlhbCBzeXN0ZW0gbWVzc2FnZVxuICAgICAgICAgIGNvbnN0IHJlbW90ZVNlc3Npb25VcmwgPSBgJHtnZXRSZW1vdGVTZXNzaW9uVXJsKGNyZWF0ZWRTZXNzaW9uLmlkKX0/bT0wYFxuICAgICAgICAgIGNvbnN0IHJlbW90ZUluZm9NZXNzYWdlID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICAgIGAvcmVtb3RlLWNvbnRyb2wgaXMgYWN0aXZlLiBDb2RlIGluIENMSSBvciBhdCAke3JlbW90ZVNlc3Npb25Vcmx9YCxcbiAgICAgICAgICAgICdpbmZvJyxcbiAgICAgICAgICApXG5cbiAgICAgICAgICAvLyBDcmVhdGUgaW5pdGlhbCB1c2VyIG1lc3NhZ2UgZnJvbSB0aGUgcHJvbXB0IGlmIHByb3ZpZGVkIChDQ1IgZWNob2VzIGl0IGJhY2sgYnV0IHdlIGlnbm9yZSB0aGF0KVxuICAgICAgICAgIGNvbnN0IGluaXRpYWxVc2VyTWVzc2FnZSA9IGhhc0luaXRpYWxQcm9tcHRcbiAgICAgICAgICAgID8gY3JlYXRlVXNlck1lc3NhZ2UoeyBjb250ZW50OiByZW1vdGUgfSlcbiAgICAgICAgICAgIDogbnVsbFxuXG4gICAgICAgICAgLy8gU2V0IHJlbW90ZSBzZXNzaW9uIFVSTCBpbiBhcHAgc3RhdGUgZm9yIGZvb3RlciBpbmRpY2F0b3JcbiAgICAgICAgICBjb25zdCByZW1vdGVJbml0aWFsU3RhdGUgPSB7XG4gICAgICAgICAgICAuLi5pbml0aWFsU3RhdGUsXG4gICAgICAgICAgICByZW1vdGVTZXNzaW9uVXJsLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFByZS1maWx0ZXIgY29tbWFuZHMgdG8gb25seSBpbmNsdWRlIHJlbW90ZS1zYWZlIG9uZXMuXG4gICAgICAgICAgLy8gQ0NSJ3MgaW5pdCByZXNwb25zZSBtYXkgZnVydGhlciByZWZpbmUgdGhlIGxpc3QgKHZpYSBoYW5kbGVSZW1vdGVJbml0IGluIFJFUEwpLlxuICAgICAgICAgIGNvbnN0IHJlbW90ZUNvbW1hbmRzID0gZmlsdGVyQ29tbWFuZHNGb3JSZW1vdGVNb2RlKGNvbW1hbmRzKVxuICAgICAgICAgIGF3YWl0IGxhdW5jaFJlcGwoXG4gICAgICAgICAgICByb290LFxuICAgICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlOiByZW1vdGVJbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgZGVidWc6IGRlYnVnIHx8IGRlYnVnVG9TdGRlcnIsXG4gICAgICAgICAgICAgIGNvbW1hbmRzOiByZW1vdGVDb21tYW5kcyxcbiAgICAgICAgICAgICAgaW5pdGlhbFRvb2xzOiBbXSxcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiBpbml0aWFsVXNlck1lc3NhZ2VcbiAgICAgICAgICAgICAgICA/IFtyZW1vdGVJbmZvTWVzc2FnZSwgaW5pdGlhbFVzZXJNZXNzYWdlXVxuICAgICAgICAgICAgICAgIDogW3JlbW90ZUluZm9NZXNzYWdlXSxcbiAgICAgICAgICAgICAgbWNwQ2xpZW50czogW10sXG4gICAgICAgICAgICAgIGF1dG9Db25uZWN0SWRlRmxhZzogaWRlLFxuICAgICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uLFxuICAgICAgICAgICAgICBkaXNhYmxlU2xhc2hDb21tYW5kcyxcbiAgICAgICAgICAgICAgcmVtb3RlU2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgICAgdGhpbmtpbmdDb25maWcsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgcmVuZGVyQW5kUnVuLFxuICAgICAgICAgIClcbiAgICAgICAgICByZXR1cm5cbiAgICAgICAgfSBlbHNlIGlmICh0ZWxlcG9ydCkge1xuICAgICAgICAgIGlmICh0ZWxlcG9ydCA9PT0gdHJ1ZSB8fCB0ZWxlcG9ydCA9PT0gJycpIHtcbiAgICAgICAgICAgIC8vIEludGVyYWN0aXZlIG1vZGU6IHNob3cgdGFzayBzZWxlY3RvciBhbmQgaGFuZGxlIHJlc3VtZVxuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3RlbGVwb3J0X2ludGVyYWN0aXZlX21vZGUnLCB7fSlcbiAgICAgICAgICAgIGxvZ0ZvckRlYnVnZ2luZyhcbiAgICAgICAgICAgICAgJ3NlbGVjdEFuZFJlc3VtZVRlbGVwb3J0VGFzazogU3RhcnRpbmcgdGVsZXBvcnQgZmxvdy4uLicsXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCB0ZWxlcG9ydFJlc3VsdCA9IGF3YWl0IGxhdW5jaFRlbGVwb3J0UmVzdW1lV3JhcHBlcihyb290KVxuICAgICAgICAgICAgaWYgKCF0ZWxlcG9ydFJlc3VsdCkge1xuICAgICAgICAgICAgICAvLyBVc2VyIGNhbmNlbGxlZCBvciBlcnJvciBvY2N1cnJlZFxuICAgICAgICAgICAgICBhd2FpdCBncmFjZWZ1bFNodXRkb3duKDApXG4gICAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc3QgeyBicmFuY2hFcnJvciB9ID0gYXdhaXQgY2hlY2tPdXRUZWxlcG9ydGVkU2Vzc2lvbkJyYW5jaChcbiAgICAgICAgICAgICAgdGVsZXBvcnRSZXN1bHQuYnJhbmNoLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgbWVzc2FnZXMgPSBwcm9jZXNzTWVzc2FnZXNGb3JUZWxlcG9ydFJlc3VtZShcbiAgICAgICAgICAgICAgdGVsZXBvcnRSZXN1bHQubG9nLFxuICAgICAgICAgICAgICBicmFuY2hFcnJvcixcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB0ZWxlcG9ydCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV90ZWxlcG9ydF9yZXN1bWVfc2Vzc2lvbicsIHtcbiAgICAgICAgICAgICAgbW9kZTogJ2RpcmVjdCcgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAvLyBGaXJzdCwgZmV0Y2ggc2Vzc2lvbiBhbmQgdmFsaWRhdGUgcmVwb3NpdG9yeSBiZWZvcmUgY2hlY2tpbmcgZ2l0IHN0YXRlXG4gICAgICAgICAgICAgIGNvbnN0IHNlc3Npb25EYXRhID0gYXdhaXQgZmV0Y2hTZXNzaW9uKHRlbGVwb3J0KVxuICAgICAgICAgICAgICBjb25zdCByZXBvVmFsaWRhdGlvbiA9XG4gICAgICAgICAgICAgICAgYXdhaXQgdmFsaWRhdGVTZXNzaW9uUmVwb3NpdG9yeShzZXNzaW9uRGF0YSlcblxuICAgICAgICAgICAgICAvLyBIYW5kbGUgcmVwbyBtaXNtYXRjaCBvciBub3QgaW4gcmVwbyBjYXNlc1xuICAgICAgICAgICAgICBpZiAoXG4gICAgICAgICAgICAgICAgcmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnbWlzbWF0Y2gnIHx8XG4gICAgICAgICAgICAgICAgcmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnbm90X2luX3JlcG8nXG4gICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgIGNvbnN0IHNlc3Npb25SZXBvID0gcmVwb1ZhbGlkYXRpb24uc2Vzc2lvblJlcG9cbiAgICAgICAgICAgICAgICBpZiAoc2Vzc2lvblJlcG8pIHtcbiAgICAgICAgICAgICAgICAgIC8vIENoZWNrIGZvciBrbm93biBwYXRoc1xuICAgICAgICAgICAgICAgICAgY29uc3Qga25vd25QYXRocyA9IGdldEtub3duUGF0aHNGb3JSZXBvKHNlc3Npb25SZXBvKVxuICAgICAgICAgICAgICAgICAgY29uc3QgZXhpc3RpbmdQYXRocyA9IGF3YWl0IGZpbHRlckV4aXN0aW5nUGF0aHMoa25vd25QYXRocylcblxuICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUGF0aHMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICAvLyBTaG93IGRpcmVjdG9yeSBzd2l0Y2ggZGlhbG9nXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IHNlbGVjdGVkUGF0aCA9IGF3YWl0IGxhdW5jaFRlbGVwb3J0UmVwb01pc21hdGNoRGlhbG9nKFxuICAgICAgICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFyZ2V0UmVwbzogc2Vzc2lvblJlcG8sXG4gICAgICAgICAgICAgICAgICAgICAgICBpbml0aWFsUGF0aHM6IGV4aXN0aW5nUGF0aHMsXG4gICAgICAgICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICAgICAgKVxuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzZWxlY3RlZFBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAvLyBDaGFuZ2UgdG8gdGhlIHNlbGVjdGVkIGRpcmVjdG9yeVxuICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3MuY2hkaXIoc2VsZWN0ZWRQYXRoKVxuICAgICAgICAgICAgICAgICAgICAgIHNldEN3ZChzZWxlY3RlZFBhdGgpXG4gICAgICAgICAgICAgICAgICAgICAgc2V0T3JpZ2luYWxDd2Qoc2VsZWN0ZWRQYXRoKVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgIC8vIFVzZXIgY2FuY2VsbGVkXG4gICAgICAgICAgICAgICAgICAgICAgYXdhaXQgZ3JhY2VmdWxTaHV0ZG93bigwKVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvLyBObyBrbm93biBwYXRocyAtIHNob3cgb3JpZ2luYWwgZXJyb3JcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgYFlvdSBtdXN0IHJ1biBjbGF1ZGUgLS10ZWxlcG9ydCAke3RlbGVwb3J0fSBmcm9tIGEgY2hlY2tvdXQgb2YgJHtzZXNzaW9uUmVwb30uYCxcbiAgICAgICAgICAgICAgICAgICAgICBjaGFsay5yZWQoXG4gICAgICAgICAgICAgICAgICAgICAgICBgWW91IG11c3QgcnVuIGNsYXVkZSAtLXRlbGVwb3J0ICR7dGVsZXBvcnR9IGZyb20gYSBjaGVja291dCBvZiAke2NoYWxrLmJvbGQoc2Vzc2lvblJlcG8pfS5cXG5gLFxuICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVwb1ZhbGlkYXRpb24uc3RhdHVzID09PSAnZXJyb3InKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICByZXBvVmFsaWRhdGlvbi5lcnJvck1lc3NhZ2UgfHwgJ0ZhaWxlZCB0byB2YWxpZGF0ZSBzZXNzaW9uJyxcbiAgICAgICAgICAgICAgICAgIGNoYWxrLnJlZChcbiAgICAgICAgICAgICAgICAgICAgYEVycm9yOiAke3JlcG9WYWxpZGF0aW9uLmVycm9yTWVzc2FnZSB8fCAnRmFpbGVkIHRvIHZhbGlkYXRlIHNlc3Npb24nfVxcbmAsXG4gICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGF3YWl0IHZhbGlkYXRlR2l0U3RhdGUoKVxuXG4gICAgICAgICAgICAgIC8vIFVzZSBwcm9ncmVzcyBVSSBmb3IgdGVsZXBvcnRcbiAgICAgICAgICAgICAgY29uc3QgeyB0ZWxlcG9ydFdpdGhQcm9ncmVzcyB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICAgICAgICcuL2NvbXBvbmVudHMvVGVsZXBvcnRQcm9ncmVzcy5qcydcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0ZWxlcG9ydFdpdGhQcm9ncmVzcyhyb290LCB0ZWxlcG9ydClcbiAgICAgICAgICAgICAgLy8gVHJhY2sgdGVsZXBvcnRlZCBzZXNzaW9uIGZvciByZWxpYWJpbGl0eSBsb2dnaW5nXG4gICAgICAgICAgICAgIHNldFRlbGVwb3J0ZWRTZXNzaW9uSW5mbyh7IHNlc3Npb25JZDogdGVsZXBvcnQgfSlcbiAgICAgICAgICAgICAgbWVzc2FnZXMgPSByZXN1bHQubWVzc2FnZXNcbiAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIFRlbGVwb3J0T3BlcmF0aW9uRXJyb3IpIHtcbiAgICAgICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShlcnJvci5mb3JtYXR0ZWRNZXNzYWdlICsgJ1xcbicpXG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgICBjaGFsay5yZWQoYEVycm9yOiAke2Vycm9yTWVzc2FnZShlcnJvcil9XFxuYCksXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIGF3YWl0IGdyYWNlZnVsU2h1dGRvd24oMSlcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICAgICAgICBpZiAoXG4gICAgICAgICAgICBvcHRpb25zLnJlc3VtZSAmJlxuICAgICAgICAgICAgdHlwZW9mIG9wdGlvbnMucmVzdW1lID09PSAnc3RyaW5nJyAmJlxuICAgICAgICAgICAgIW1heWJlU2Vzc2lvbklkXG4gICAgICAgICAgKSB7XG4gICAgICAgICAgICAvLyBDaGVjayBmb3IgY2NzaGFyZSBVUkwgKGUuZy4gaHR0cHM6Ly9nby9jY3NoYXJlL2JvcmlzLTIwMjYwMzExLTIxMTAzNilcbiAgICAgICAgICAgIGNvbnN0IHsgcGFyc2VDY3NoYXJlSWQsIGxvYWRDY3NoYXJlIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAgICcuL3V0aWxzL2Njc2hhcmVSZXN1bWUuanMnXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBjb25zdCBjY3NoYXJlSWQgPSBwYXJzZUNjc2hhcmVJZChvcHRpb25zLnJlc3VtZSlcbiAgICAgICAgICAgIGlmIChjY3NoYXJlSWQpIHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG4gICAgICAgICAgICAgICAgY29uc3QgbG9nT3B0aW9uID0gYXdhaXQgbG9hZENjc2hhcmUoY2NzaGFyZUlkKVxuICAgICAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IGxvYWRDb252ZXJzYXRpb25Gb3JSZXN1bWUoXG4gICAgICAgICAgICAgICAgICBsb2dPcHRpb24sXG4gICAgICAgICAgICAgICAgICB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZSA9IGF3YWl0IHByb2Nlc3NSZXN1bWVkQ29udmVyc2F0aW9uKFxuICAgICAgICAgICAgICAgICAgICByZXN1bHQsXG4gICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICBmb3JrU2Vzc2lvbjogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0UGF0aDogcmVzdWx0LmZ1bGxQYXRoLFxuICAgICAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgICAgICByZXN1bWVDb250ZXh0LFxuICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgaWYgKHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmKSB7XG4gICAgICAgICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gPSBwcm9jZXNzZWRSZXN1bWUucmVzdG9yZWRBZ2VudERlZlxuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgICAgZW50cnlwb2ludDpcbiAgICAgICAgICAgICAgICAgICAgICAnY2NzaGFyZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgcmVzdW1lX2R1cmF0aW9uX21zOiBNYXRoLnJvdW5kKFxuICAgICAgICAgICAgICAgICAgICAgIHBlcmZvcm1hbmNlLm5vdygpIC0gcmVzdW1lU3RhcnQsXG4gICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc2Vzc2lvbl9yZXN1bWVkJywge1xuICAgICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAgICdjY3NoYXJlJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zZXNzaW9uX3Jlc3VtZWQnLCB7XG4gICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAnY2NzaGFyZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgbG9nRXJyb3IoZXJyb3IpXG4gICAgICAgICAgICAgICAgYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICAgICAgICBgVW5hYmxlIHRvIHJlc3VtZSBmcm9tIGNjc2hhcmU6ICR7ZXJyb3JNZXNzYWdlKGVycm9yKX1gLFxuICAgICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlc29sdmVkUGF0aCA9IHJlc29sdmUob3B0aW9ucy5yZXN1bWUpXG4gICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgY29uc3QgcmVzdW1lU3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKVxuICAgICAgICAgICAgICAgIGxldCBsb2dPcHRpb25cbiAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgLy8gQXR0ZW1wdCB0byBsb2FkIGFzIGEgdHJhbnNjcmlwdCBmaWxlOyBFTk9FTlQgZmFsbHMgdGhyb3VnaCB0byBzZXNzaW9uLUlEIGhhbmRsaW5nXG4gICAgICAgICAgICAgICAgICBsb2dPcHRpb24gPSBhd2FpdCBsb2FkVHJhbnNjcmlwdEZyb21GaWxlKHJlc29sdmVkUGF0aClcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgaWYgKCFpc0VOT0VOVChlcnJvcikpIHRocm93IGVycm9yXG4gICAgICAgICAgICAgICAgICAvLyBFTk9FTlQ6IG5vdCBhIGZpbGUgcGF0aCBcdTIwMTQgZmFsbCB0aHJvdWdoIHRvIHNlc3Npb24tSUQgaGFuZGxpbmdcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGxvZ09wdGlvbikge1xuICAgICAgICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZShcbiAgICAgICAgICAgICAgICAgICAgbG9nT3B0aW9uLFxuICAgICAgICAgICAgICAgICAgICB1bmRlZmluZWQgLyogc291cmNlRmlsZSAqLyxcbiAgICAgICAgICAgICAgICAgIClcbiAgICAgICAgICAgICAgICAgIGlmIChyZXN1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgcHJvY2Vzc2VkUmVzdW1lID0gYXdhaXQgcHJvY2Vzc1Jlc3VtZWRDb252ZXJzYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGZvcmtTZXNzaW9uOiAhIW9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgICAgICAgICAgICB0cmFuc2NyaXB0UGF0aDogcmVzdWx0LmZ1bGxQYXRoLFxuICAgICAgICAgICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgICAgICAgICAgcmVzdW1lQ29udGV4dCxcbiAgICAgICAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgICAgICAgICBpZiAocHJvY2Vzc2VkUmVzdW1lLnJlc3RvcmVkQWdlbnREZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICBtYWluVGhyZWFkQWdlbnREZWZpbml0aW9uID1cbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmXG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgICAgICAgJ2ZpbGUnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgICAgICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgICAgICAgICAgICAgICAgICByZXN1bWVfZHVyYXRpb25fbXM6IE1hdGgucm91bmQoXG4gICAgICAgICAgICAgICAgICAgICAgICBwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0LFxuICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgIH0pXG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsb2dFdmVudCgndGVuZ3Vfc2Vzc2lvbl9yZXN1bWVkJywge1xuICAgICAgICAgICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAnZmlsZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgICAgICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgICAgICdmaWxlJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgICAgICAgICAgfSlcbiAgICAgICAgICAgICAgICBsb2dFcnJvcihlcnJvcilcbiAgICAgICAgICAgICAgICBhd2FpdCBleGl0V2l0aEVycm9yKFxuICAgICAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgICAgIGBVbmFibGUgdG8gbG9hZCB0cmFuc2NyaXB0IGZyb20gZmlsZTogJHtvcHRpb25zLnJlc3VtZX1gLFxuICAgICAgICAgICAgICAgICAgKCkgPT4gZ3JhY2VmdWxTaHV0ZG93bigxKSxcbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiBub3QgbG9hZGVkIGFzIGEgZmlsZSwgdHJ5IGFzIHNlc3Npb24gSURcbiAgICAgICAgaWYgKG1heWJlU2Vzc2lvbklkKSB7XG4gICAgICAgICAgLy8gUmVzdW1lIHNwZWNpZmljIHNlc3Npb24gYnkgSURcbiAgICAgICAgICBjb25zdCBzZXNzaW9uSWQgPSBtYXliZVNlc3Npb25JZFxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCByZXN1bWVTdGFydCA9IHBlcmZvcm1hbmNlLm5vdygpXG4gICAgICAgICAgICAvLyBVc2UgbWF0Y2hlZExvZyBpZiBhdmFpbGFibGUgKGZvciBjcm9zcy13b3JrdHJlZSByZXN1bWUgYnkgY3VzdG9tIHRpdGxlKVxuICAgICAgICAgICAgLy8gT3RoZXJ3aXNlIGZhbGwgYmFjayB0byBzZXNzaW9uSWQgc3RyaW5nIChmb3IgZGlyZWN0IFVVSUQgcmVzdW1lKVxuICAgICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgbG9hZENvbnZlcnNhdGlvbkZvclJlc3VtZShcbiAgICAgICAgICAgICAgbWF0Y2hlZExvZyA/PyBzZXNzaW9uSWQsXG4gICAgICAgICAgICAgIHVuZGVmaW5lZCxcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcbiAgICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgICBlbnRyeXBvaW50OlxuICAgICAgICAgICAgICAgICAgJ2NsaV9mbGFnJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgICAgICB9KVxuICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgICByb290LFxuICAgICAgICAgICAgICAgIGBObyBjb252ZXJzYXRpb24gZm91bmQgd2l0aCBzZXNzaW9uIElEOiAke3Nlc3Npb25JZH1gLFxuICAgICAgICAgICAgICApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnN0IGZ1bGxQYXRoID0gbWF0Y2hlZExvZz8uZnVsbFBhdGggPz8gcmVzdWx0LmZ1bGxQYXRoXG4gICAgICAgICAgICBwcm9jZXNzZWRSZXN1bWUgPSBhd2FpdCBwcm9jZXNzUmVzdW1lZENvbnZlcnNhdGlvbihcbiAgICAgICAgICAgICAgcmVzdWx0LFxuICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgZm9ya1Nlc3Npb246ICEhb3B0aW9ucy5mb3JrU2Vzc2lvbixcbiAgICAgICAgICAgICAgICBzZXNzaW9uSWRPdmVycmlkZTogc2Vzc2lvbklkLFxuICAgICAgICAgICAgICAgIHRyYW5zY3JpcHRQYXRoOiBmdWxsUGF0aCxcbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgcmVzdW1lQ29udGV4dCxcbiAgICAgICAgICAgIClcblxuICAgICAgICAgICAgaWYgKHByb2Nlc3NlZFJlc3VtZS5yZXN0b3JlZEFnZW50RGVmKSB7XG4gICAgICAgICAgICAgIG1haW5UaHJlYWRBZ2VudERlZmluaXRpb24gPSBwcm9jZXNzZWRSZXN1bWUucmVzdG9yZWRBZ2VudERlZlxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X3Nlc3Npb25fcmVzdW1lZCcsIHtcbiAgICAgICAgICAgICAgZW50cnlwb2ludDpcbiAgICAgICAgICAgICAgICAnY2xpX2ZsYWcnIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICAgICAgICAgIHJlc3VtZV9kdXJhdGlvbl9tczogTWF0aC5yb3VuZChwZXJmb3JtYW5jZS5ub3coKSAtIHJlc3VtZVN0YXJ0KSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxvZ0V2ZW50KCd0ZW5ndV9zZXNzaW9uX3Jlc3VtZWQnLCB7XG4gICAgICAgICAgICAgIGVudHJ5cG9pbnQ6XG4gICAgICAgICAgICAgICAgJ2NsaV9mbGFnJyBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgICAgICAgICBzdWNjZXNzOiBmYWxzZSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBsb2dFcnJvcihlcnJvcilcbiAgICAgICAgICAgIGF3YWl0IGV4aXRXaXRoRXJyb3Iocm9vdCwgYEZhaWxlZCB0byByZXN1bWUgc2Vzc2lvbiAke3Nlc3Npb25JZH1gKVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIEF3YWl0IGZpbGUgZG93bmxvYWRzIGJlZm9yZSByZW5kZXJpbmcgUkVQTCAoZmlsZXMgbXVzdCBiZSBhdmFpbGFibGUpXG4gICAgICAgIGlmIChmaWxlRG93bmxvYWRQcm9taXNlKSB7XG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBmaWxlRG93bmxvYWRQcm9taXNlXG4gICAgICAgICAgICBjb25zdCBmYWlsZWRDb3VudCA9IGNvdW50KHJlc3VsdHMsIHIgPT4gIXIuc3VjY2VzcylcbiAgICAgICAgICAgIGlmIChmYWlsZWRDb3VudCA+IDApIHtcbiAgICAgICAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgICAgICAgY2hhbGsueWVsbG93KFxuICAgICAgICAgICAgICAgICAgYFdhcm5pbmc6ICR7ZmFpbGVkQ291bnR9LyR7cmVzdWx0cy5sZW5ndGh9IGZpbGUocykgZmFpbGVkIHRvIGRvd25sb2FkLlxcbmAsXG4gICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgKVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgZXhpdFdpdGhFcnJvcihcbiAgICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgICAgYEVycm9yIGRvd25sb2FkaW5nIGZpbGVzOiAke2Vycm9yTWVzc2FnZShlcnJvcil9YCxcbiAgICAgICAgICAgIClcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBJZiB3ZSBoYXZlIGEgcHJvY2Vzc2VkIHJlc3VtZSBvciB0ZWxlcG9ydCBtZXNzYWdlcywgcmVuZGVyIHRoZSBSRVBMXG4gICAgICAgIGNvbnN0IHJlc3VtZURhdGEgPVxuICAgICAgICAgIHByb2Nlc3NlZFJlc3VtZSA/P1xuICAgICAgICAgIChBcnJheS5pc0FycmF5KG1lc3NhZ2VzKVxuICAgICAgICAgICAgPyB7XG4gICAgICAgICAgICAgICAgbWVzc2FnZXMsXG4gICAgICAgICAgICAgICAgZmlsZUhpc3RvcnlTbmFwc2hvdHM6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBhZ2VudE5hbWU6IHVuZGVmaW5lZCxcbiAgICAgICAgICAgICAgICBhZ2VudENvbG9yOiB1bmRlZmluZWQgYXMgQWdlbnRDb2xvck5hbWUgfCB1bmRlZmluZWQsXG4gICAgICAgICAgICAgICAgcmVzdG9yZWRBZ2VudERlZjogbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgICBpbml0aWFsU3RhdGUsXG4gICAgICAgICAgICAgICAgY29udGVudFJlcGxhY2VtZW50czogdW5kZWZpbmVkLFxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICA6IHVuZGVmaW5lZClcbiAgICAgICAgaWYgKHJlc3VtZURhdGEpIHtcbiAgICAgICAgICBtYXliZUFjdGl2YXRlUHJvYWN0aXZlKG9wdGlvbnMpXG4gICAgICAgICAgbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnMpXG5cbiAgICAgICAgICBhd2FpdCBsYXVuY2hSZXBsKFxuICAgICAgICAgICAgcm9vdCxcbiAgICAgICAgICAgIHsgZ2V0RnBzTWV0cmljcywgc3RhdHMsIGluaXRpYWxTdGF0ZTogcmVzdW1lRGF0YS5pbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgLi4uc2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgICAgbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbjpcbiAgICAgICAgICAgICAgICByZXN1bWVEYXRhLnJlc3RvcmVkQWdlbnREZWYgPz8gbWFpblRocmVhZEFnZW50RGVmaW5pdGlvbixcbiAgICAgICAgICAgICAgaW5pdGlhbE1lc3NhZ2VzOiByZXN1bWVEYXRhLm1lc3NhZ2VzLFxuICAgICAgICAgICAgICBpbml0aWFsRmlsZUhpc3RvcnlTbmFwc2hvdHM6IHJlc3VtZURhdGEuZmlsZUhpc3RvcnlTbmFwc2hvdHMsXG4gICAgICAgICAgICAgIGluaXRpYWxDb250ZW50UmVwbGFjZW1lbnRzOiByZXN1bWVEYXRhLmNvbnRlbnRSZXBsYWNlbWVudHMsXG4gICAgICAgICAgICAgIGluaXRpYWxBZ2VudE5hbWU6IHJlc3VtZURhdGEuYWdlbnROYW1lLFxuICAgICAgICAgICAgICBpbml0aWFsQWdlbnRDb2xvcjogcmVzdW1lRGF0YS5hZ2VudENvbG9yLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIHJlbmRlckFuZFJ1bixcbiAgICAgICAgICApXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gU2hvdyBpbnRlcmFjdGl2ZSBzZWxlY3RvciAoaW5jbHVkZXMgc2FtZS1yZXBvIHdvcmt0cmVlcylcbiAgICAgICAgICAvLyBOb3RlOiBSZXN1bWVDb252ZXJzYXRpb24gbG9hZHMgbG9ncyBpbnRlcm5hbGx5IHRvIGVuc3VyZSBwcm9wZXIgR0MgYWZ0ZXIgc2VsZWN0aW9uXG4gICAgICAgICAgYXdhaXQgbGF1bmNoUmVzdW1lQ2hvb3NlcihcbiAgICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgICB7IGdldEZwc01ldHJpY3MsIHN0YXRzLCBpbml0aWFsU3RhdGUgfSxcbiAgICAgICAgICAgIGdldFdvcmt0cmVlUGF0aHMoZ2V0T3JpZ2luYWxDd2QoKSksXG4gICAgICAgICAgICB7XG4gICAgICAgICAgICAgIC4uLnNlc3Npb25Db25maWcsXG4gICAgICAgICAgICAgIGluaXRpYWxTZWFyY2hRdWVyeTogc2VhcmNoVGVybSxcbiAgICAgICAgICAgICAgZm9ya1Nlc3Npb246IG9wdGlvbnMuZm9ya1Nlc3Npb24sXG4gICAgICAgICAgICAgIGZpbHRlckJ5UHIsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIClcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gUGFzcyB1bnJlc29sdmVkIGhvb2tzIHByb21pc2UgdG8gUkVQTCBzbyBpdCBjYW4gcmVuZGVyIGltbWVkaWF0ZWx5XG4gICAgICAgIC8vIGluc3RlYWQgb2YgYmxvY2tpbmcgfjUwMG1zIHdhaXRpbmcgZm9yIFNlc3Npb25TdGFydCBob29rcyB0byBmaW5pc2guXG4gICAgICAgIC8vIFJFUEwgd2lsbCBpbmplY3QgaG9vayBtZXNzYWdlcyB3aGVuIHRoZXkgcmVzb2x2ZSBhbmQgYXdhaXQgdGhlbSBiZWZvcmVcbiAgICAgICAgLy8gdGhlIGZpcnN0IEFQSSBjYWxsIHNvIHRoZSBtb2RlbCBhbHdheXMgc2VlcyBob29rIGNvbnRleHQuXG4gICAgICAgIGNvbnN0IHBlbmRpbmdIb29rTWVzc2FnZXMgPVxuICAgICAgICAgIGhvb2tzUHJvbWlzZSAmJiBob29rTWVzc2FnZXMubGVuZ3RoID09PSAwID8gaG9va3NQcm9taXNlIDogdW5kZWZpbmVkXG5cbiAgICAgICAgcHJvZmlsZUNoZWNrcG9pbnQoJ2FjdGlvbl9hZnRlcl9ob29rcycpXG4gICAgICAgIG1heWJlQWN0aXZhdGVQcm9hY3RpdmUob3B0aW9ucylcbiAgICAgICAgbWF5YmVBY3RpdmF0ZUJyaWVmKG9wdGlvbnMpXG4gICAgICAgIC8vIFBlcnNpc3QgdGhlIGN1cnJlbnQgbW9kZSBmb3IgZnJlc2ggc2Vzc2lvbnMgc28gZnV0dXJlIHJlc3VtZXMga25vdyB3aGF0IG1vZGUgd2FzIHVzZWRcbiAgICAgICAgaWYgKGZlYXR1cmUoJ0NPT1JESU5BVE9SX01PREUnKSkge1xuICAgICAgICAgIHNhdmVNb2RlKFxuICAgICAgICAgICAgY29vcmRpbmF0b3JNb2RlTW9kdWxlPy5pc0Nvb3JkaW5hdG9yTW9kZSgpXG4gICAgICAgICAgICAgID8gJ2Nvb3JkaW5hdG9yJ1xuICAgICAgICAgICAgICA6ICdub3JtYWwnLFxuICAgICAgICAgIClcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIElmIGxhdW5jaGVkIHZpYSBhIGRlZXAgbGluaywgc2hvdyBhIHByb3ZlbmFuY2UgYmFubmVyIHNvIHRoZSB1c2VyXG4gICAgICAgIC8vIGtub3dzIHRoZSBzZXNzaW9uIG9yaWdpbmF0ZWQgZXh0ZXJuYWxseS4gTGludXggeGRnLW9wZW4gYW5kXG4gICAgICAgIC8vIGJyb3dzZXJzIHdpdGggXCJhbHdheXMgYWxsb3dcIiBzZXQgZGlzcGF0Y2ggdGhlIGxpbmsgd2l0aCBubyBPUy1sZXZlbFxuICAgICAgICAvLyBjb25maXJtYXRpb24sIHNvIHRoaXMgaXMgdGhlIG9ubHkgc2lnbmFsIHRoZSB1c2VyIGdldHMgdGhhdCB0aGVcbiAgICAgICAgLy8gcHJvbXB0IFx1MjAxNCBhbmQgdGhlIHdvcmtpbmcgZGlyZWN0b3J5IC8gQ0xBVURFLm1kIGl0IGltcGxpZXMgXHUyMDE0IGNhbWVcbiAgICAgICAgLy8gZnJvbSBhbiBleHRlcm5hbCBzb3VyY2UgcmF0aGVyIHRoYW4gc29tZXRoaW5nIHRoZXkgdHlwZWQuXG4gICAgICAgIGxldCBkZWVwTGlua0Jhbm5lcjogUmV0dXJuVHlwZTx0eXBlb2YgY3JlYXRlU3lzdGVtTWVzc2FnZT4gfCBudWxsID0gbnVsbFxuICAgICAgICBpZiAoZmVhdHVyZSgnTE9ERVNUT05FJykpIHtcbiAgICAgICAgICBpZiAob3B0aW9ucy5kZWVwTGlua09yaWdpbikge1xuICAgICAgICAgICAgbG9nRXZlbnQoJ3Rlbmd1X2RlZXBfbGlua19vcGVuZWQnLCB7XG4gICAgICAgICAgICAgIGhhc19wcmVmaWxsOiBCb29sZWFuKG9wdGlvbnMucHJlZmlsbCksXG4gICAgICAgICAgICAgIGhhc19yZXBvOiBCb29sZWFuKG9wdGlvbnMuZGVlcExpbmtSZXBvKSxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBkZWVwTGlua0Jhbm5lciA9IGNyZWF0ZVN5c3RlbU1lc3NhZ2UoXG4gICAgICAgICAgICAgIGJ1aWxkRGVlcExpbmtCYW5uZXIoe1xuICAgICAgICAgICAgICAgIGN3ZDogZ2V0Q3dkKCksXG4gICAgICAgICAgICAgICAgcHJlZmlsbExlbmd0aDogb3B0aW9ucy5wcmVmaWxsPy5sZW5ndGgsXG4gICAgICAgICAgICAgICAgcmVwbzogb3B0aW9ucy5kZWVwTGlua1JlcG8sXG4gICAgICAgICAgICAgICAgbGFzdEZldGNoOlxuICAgICAgICAgICAgICAgICAgb3B0aW9ucy5kZWVwTGlua0xhc3RGZXRjaCAhPT0gdW5kZWZpbmVkXG4gICAgICAgICAgICAgICAgICAgID8gbmV3IERhdGUob3B0aW9ucy5kZWVwTGlua0xhc3RGZXRjaClcbiAgICAgICAgICAgICAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgICAgICAgICAgIH0pLFxuICAgICAgICAgICAgICAnd2FybmluZycsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfSBlbHNlIGlmIChvcHRpb25zLnByZWZpbGwpIHtcbiAgICAgICAgICAgIGRlZXBMaW5rQmFubmVyID0gY3JlYXRlU3lzdGVtTWVzc2FnZShcbiAgICAgICAgICAgICAgJ0xhdW5jaGVkIHdpdGggYSBwcmUtZmlsbGVkIHByb21wdCBcdTIwMTQgcmV2aWV3IGl0IGJlZm9yZSBwcmVzc2luZyBFbnRlci4nLFxuICAgICAgICAgICAgICAnd2FybmluZycsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNvbnN0IGluaXRpYWxNZXNzYWdlcyA9IGRlZXBMaW5rQmFubmVyXG4gICAgICAgICAgPyBbZGVlcExpbmtCYW5uZXIsIC4uLmhvb2tNZXNzYWdlc11cbiAgICAgICAgICA6IGhvb2tNZXNzYWdlcy5sZW5ndGggPiAwXG4gICAgICAgICAgICA/IGhvb2tNZXNzYWdlc1xuICAgICAgICAgICAgOiB1bmRlZmluZWRcblxuICAgICAgICBhd2FpdCBsYXVuY2hSZXBsKFxuICAgICAgICAgIHJvb3QsXG4gICAgICAgICAgeyBnZXRGcHNNZXRyaWNzLCBzdGF0cywgaW5pdGlhbFN0YXRlIH0sXG4gICAgICAgICAge1xuICAgICAgICAgICAgLi4uc2Vzc2lvbkNvbmZpZyxcbiAgICAgICAgICAgIGluaXRpYWxNZXNzYWdlcyxcbiAgICAgICAgICAgIHBlbmRpbmdIb29rTWVzc2FnZXMsXG4gICAgICAgICAgfSxcbiAgICAgICAgICByZW5kZXJBbmRSdW4sXG4gICAgICAgIClcbiAgICAgIH1cbiAgICB9KVxuICAgIC52ZXJzaW9uKFxuICAgICAgYCR7TUFDUk8uVkVSU0lPTn0gKENsYXVkZSBDb2RlKWAsXG4gICAgICAnLXYsIC0tdmVyc2lvbicsXG4gICAgICAnT3V0cHV0IHRoZSB2ZXJzaW9uIG51bWJlcicsXG4gICAgKVxuXG4gIC8vIFdvcmt0cmVlIGZsYWdzXG4gIHByb2dyYW0ub3B0aW9uKFxuICAgICctdywgLS13b3JrdHJlZSBbbmFtZV0nLFxuICAgICdDcmVhdGUgYSBuZXcgZ2l0IHdvcmt0cmVlIGZvciB0aGlzIHNlc3Npb24gKG9wdGlvbmFsbHkgc3BlY2lmeSBhIG5hbWUpJyxcbiAgKVxuICBwcm9ncmFtLm9wdGlvbihcbiAgICAnLS10bXV4JyxcbiAgICAnQ3JlYXRlIGEgdG11eCBzZXNzaW9uIGZvciB0aGUgd29ya3RyZWUgKHJlcXVpcmVzIC0td29ya3RyZWUpLiBVc2VzIGlUZXJtMiBuYXRpdmUgcGFuZXMgd2hlbiBhdmFpbGFibGU7IHVzZSAtLXRtdXg9Y2xhc3NpYyBmb3IgdHJhZGl0aW9uYWwgdG11eC4nLFxuICApXG5cbiAgaWYgKGNhblVzZXJDb25maWd1cmVBZHZpc29yKCkpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWFkdmlzb3IgPG1vZGVsPicsXG4gICAgICAgICdFbmFibGUgdGhlIHNlcnZlci1zaWRlIGFkdmlzb3IgdG9vbCB3aXRoIHRoZSBzcGVjaWZpZWQgbW9kZWwgKGFsaWFzIG9yIGZ1bGwgSUQpLicsXG4gICAgICApLmhpZGVIZWxwKCksXG4gICAgKVxuICB9XG5cbiAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWRlbGVnYXRlLXBlcm1pc3Npb25zJyxcbiAgICAgICAgJ1tBTlQtT05MWV0gQWxpYXMgZm9yIC0tcGVybWlzc2lvbi1tb2RlIGF1dG8uJyxcbiAgICAgICkuaW1wbGllcyh7IHBlcm1pc3Npb25Nb2RlOiAnYXV0bycgfSksXG4gICAgKVxuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tZGFuZ2Vyb3VzbHktc2tpcC1wZXJtaXNzaW9ucy13aXRoLWNsYXNzaWZpZXJzJyxcbiAgICAgICAgJ1tBTlQtT05MWV0gRGVwcmVjYXRlZCBhbGlhcyBmb3IgLS1wZXJtaXNzaW9uLW1vZGUgYXV0by4nLFxuICAgICAgKVxuICAgICAgICAuaGlkZUhlbHAoKVxuICAgICAgICAuaW1wbGllcyh7IHBlcm1pc3Npb25Nb2RlOiAnYXV0bycgfSksXG4gICAgKVxuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tYWZrJyxcbiAgICAgICAgJ1tBTlQtT05MWV0gRGVwcmVjYXRlZCBhbGlhcyBmb3IgLS1wZXJtaXNzaW9uLW1vZGUgYXV0by4nLFxuICAgICAgKVxuICAgICAgICAuaGlkZUhlbHAoKVxuICAgICAgICAuaW1wbGllcyh7IHBlcm1pc3Npb25Nb2RlOiAnYXV0bycgfSksXG4gICAgKVxuICAgIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgICAgbmV3IE9wdGlvbihcbiAgICAgICAgJy0tdGFza3MgW2lkXScsXG4gICAgICAgICdbQU5ULU9OTFldIFRhc2tzIG1vZGU6IHdhdGNoIGZvciB0YXNrcyBhbmQgYXV0by1wcm9jZXNzIHRoZW0uIE9wdGlvbmFsIGlkIGlzIHVzZWQgYXMgYm90aCB0aGUgdGFzayBsaXN0IElEIGFuZCBhZ2VudCBJRCAoZGVmYXVsdHMgdG8gXCJ0YXNrbGlzdFwiKS4nLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKFN0cmluZylcbiAgICAgICAgLmhpZGVIZWxwKCksXG4gICAgKVxuICAgIHByb2dyYW0ub3B0aW9uKFxuICAgICAgJy0tYWdlbnQtdGVhbXMnLFxuICAgICAgJ1tBTlQtT05MWV0gRm9yY2UgQ2xhdWRlIHRvIHVzZSBtdWx0aS1hZ2VudCBtb2RlIGZvciBzb2x2aW5nIHByb2JsZW1zJyxcbiAgICAgICgpID0+IHRydWUsXG4gICAgKVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ1RSQU5TQ1JJUFRfQ0xBU1NJRklFUicpKSB7XG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKCctLWVuYWJsZS1hdXRvLW1vZGUnLCAnT3B0IGluIHRvIGF1dG8gbW9kZScpLmhpZGVIZWxwKCksXG4gICAgKVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ1BST0FDVElWRScpIHx8IGZlYXR1cmUoJ0tBSVJPUycpKSB7XG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKCctLXByb2FjdGl2ZScsICdTdGFydCBpbiBwcm9hY3RpdmUgYXV0b25vbW91cyBtb2RlJyksXG4gICAgKVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ1VEU19JTkJPWCcpKSB7XG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1tZXNzYWdpbmctc29ja2V0LXBhdGggPHBhdGg+JyxcbiAgICAgICAgJ1VuaXggZG9tYWluIHNvY2tldCBwYXRoIGZvciB0aGUgVURTIG1lc3NhZ2luZyBzZXJ2ZXIgKGRlZmF1bHRzIHRvIGEgdG1wIHBhdGgpJyxcbiAgICAgICksXG4gICAgKVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19CUklFRicpKSB7XG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1icmllZicsXG4gICAgICAgICdFbmFibGUgU2VuZFVzZXJNZXNzYWdlIHRvb2wgZm9yIGFnZW50LXRvLXVzZXIgY29tbXVuaWNhdGlvbicsXG4gICAgICApLFxuICAgIClcbiAgfVxuICBpZiAoZmVhdHVyZSgnS0FJUk9TJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWFzc2lzdGFudCcsXG4gICAgICAgICdGb3JjZSBhc3Npc3RhbnQgbW9kZSAoQWdlbnQgU0RLIGRhZW1vbiB1c2UpJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gIH1cbiAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpIHx8IGZlYXR1cmUoJ0tBSVJPU19DSEFOTkVMUycpKSB7XG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1jaGFubmVscyA8c2VydmVycy4uLj4nLFxuICAgICAgICAnTUNQIHNlcnZlcnMgd2hvc2UgY2hhbm5lbCBub3RpZmljYXRpb25zIChpbmJvdW5kIHB1c2gpIHNob3VsZCByZWdpc3RlciB0aGlzIHNlc3Npb24uIFNwYWNlLXNlcGFyYXRlZCBzZXJ2ZXIgbmFtZXMuJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gICAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgICBuZXcgT3B0aW9uKFxuICAgICAgICAnLS1kYW5nZXJvdXNseS1sb2FkLWRldmVsb3BtZW50LWNoYW5uZWxzIDxzZXJ2ZXJzLi4uPicsXG4gICAgICAgICdMb2FkIGNoYW5uZWwgc2VydmVycyBub3Qgb24gdGhlIGFwcHJvdmVkIGFsbG93bGlzdC4gRm9yIGxvY2FsIGNoYW5uZWwgZGV2ZWxvcG1lbnQgb25seS4gU2hvd3MgYSBjb25maXJtYXRpb24gZGlhbG9nIGF0IHN0YXJ0dXAuJyxcbiAgICAgICkuaGlkZUhlbHAoKSxcbiAgICApXG4gIH1cblxuICAvLyBUZWFtbWF0ZSBpZGVudGl0eSBvcHRpb25zIChzZXQgYnkgbGVhZGVyIHdoZW4gc3Bhd25pbmcgdG11eCB0ZWFtbWF0ZXMpXG4gIC8vIFRoZXNlIHJlcGxhY2UgdGhlIENMQVVERV9DT0RFXyogZW52aXJvbm1lbnQgdmFyaWFibGVzXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oJy0tYWdlbnQtaWQgPGlkPicsICdUZWFtbWF0ZSBhZ2VudCBJRCcpLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbignLS1hZ2VudC1uYW1lIDxuYW1lPicsICdUZWFtbWF0ZSBkaXNwbGF5IG5hbWUnKS5oaWRlSGVscCgpLFxuICApXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oXG4gICAgICAnLS10ZWFtLW5hbWUgPG5hbWU+JyxcbiAgICAgICdUZWFtIG5hbWUgZm9yIHN3YXJtIGNvb3JkaW5hdGlvbicsXG4gICAgKS5oaWRlSGVscCgpLFxuICApXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oJy0tYWdlbnQtY29sb3IgPGNvbG9yPicsICdUZWFtbWF0ZSBVSSBjb2xvcicpLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbihcbiAgICAgICctLXBsYW4tbW9kZS1yZXF1aXJlZCcsXG4gICAgICAnUmVxdWlyZSBwbGFuIG1vZGUgYmVmb3JlIGltcGxlbWVudGF0aW9uJyxcbiAgICApLmhpZGVIZWxwKCksXG4gIClcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbihcbiAgICAgICctLXBhcmVudC1zZXNzaW9uLWlkIDxpZD4nLFxuICAgICAgJ1BhcmVudCBzZXNzaW9uIElEIGZvciBhbmFseXRpY3MgY29ycmVsYXRpb24nLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tdGVhbW1hdGUtbW9kZSA8bW9kZT4nLFxuICAgICAgJ0hvdyB0byBzcGF3biB0ZWFtbWF0ZXM6IFwidG11eFwiLCBcImluLXByb2Nlc3NcIiwgb3IgXCJhdXRvXCInLFxuICAgIClcbiAgICAgIC5jaG9pY2VzKFsnYXV0bycsICd0bXV4JywgJ2luLXByb2Nlc3MnXSlcbiAgICAgIC5oaWRlSGVscCgpLFxuICApXG4gIHByb2dyYW0uYWRkT3B0aW9uKFxuICAgIG5ldyBPcHRpb24oXG4gICAgICAnLS1hZ2VudC10eXBlIDx0eXBlPicsXG4gICAgICAnQ3VzdG9tIGFnZW50IHR5cGUgZm9yIHRoaXMgdGVhbW1hdGUnLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuXG4gIC8vIEVuYWJsZSBTREsgVVJMIGZvciBhbGwgYnVpbGRzIGJ1dCBoaWRlIGZyb20gaGVscFxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tc2RrLXVybCA8dXJsPicsXG4gICAgICAnVXNlIHJlbW90ZSBXZWJTb2NrZXQgZW5kcG9pbnQgZm9yIFNESyBJL08gc3RyZWFtaW5nIChvbmx5IHdpdGggLXAgYW5kIHN0cmVhbS1qc29uIGZvcm1hdCknLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuXG4gIC8vIEVuYWJsZSB0ZWxlcG9ydC9yZW1vdGUgZmxhZ3MgZm9yIGFsbCBidWlsZHMgYnV0IGtlZXAgdGhlbSB1bmRvY3VtZW50ZWQgdW50aWwgR0FcbiAgcHJvZ3JhbS5hZGRPcHRpb24oXG4gICAgbmV3IE9wdGlvbihcbiAgICAgICctLXRlbGVwb3J0IFtzZXNzaW9uXScsXG4gICAgICAnUmVzdW1lIGEgdGVsZXBvcnQgc2Vzc2lvbiwgb3B0aW9uYWxseSBzcGVjaWZ5IHNlc3Npb24gSUQnLFxuICAgICkuaGlkZUhlbHAoKSxcbiAgKVxuICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICBuZXcgT3B0aW9uKFxuICAgICAgJy0tcmVtb3RlIFtkZXNjcmlwdGlvbl0nLFxuICAgICAgJ0NyZWF0ZSBhIHJlbW90ZSBzZXNzaW9uIHdpdGggdGhlIGdpdmVuIGRlc2NyaXB0aW9uJyxcbiAgICApLmhpZGVIZWxwKCksXG4gIClcbiAgaWYgKGZlYXR1cmUoJ0JSSURHRV9NT0RFJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLXJlbW90ZS1jb250cm9sIFtuYW1lXScsXG4gICAgICAgICdTdGFydCBhbiBpbnRlcmFjdGl2ZSBzZXNzaW9uIHdpdGggUmVtb3RlIENvbnRyb2wgZW5hYmxlZCAob3B0aW9uYWxseSBuYW1lZCknLFxuICAgICAgKVxuICAgICAgICAuYXJnUGFyc2VyKHZhbHVlID0+IHZhbHVlIHx8IHRydWUpXG4gICAgICAgIC5oaWRlSGVscCgpLFxuICAgIClcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oJy0tcmMgW25hbWVdJywgJ0FsaWFzIGZvciAtLXJlbW90ZS1jb250cm9sJylcbiAgICAgICAgLmFyZ1BhcnNlcih2YWx1ZSA9PiB2YWx1ZSB8fCB0cnVlKVxuICAgICAgICAuaGlkZUhlbHAoKSxcbiAgICApXG4gIH1cblxuICBpZiAoZmVhdHVyZSgnSEFSRF9GQUlMJykpIHtcbiAgICBwcm9ncmFtLmFkZE9wdGlvbihcbiAgICAgIG5ldyBPcHRpb24oXG4gICAgICAgICctLWhhcmQtZmFpbCcsXG4gICAgICAgICdDcmFzaCBvbiBsb2dFcnJvciBjYWxscyBpbnN0ZWFkIG9mIHNpbGVudGx5IGxvZ2dpbmcnLFxuICAgICAgKS5oaWRlSGVscCgpLFxuICAgIClcbiAgfVxuXG4gIHByb2ZpbGVDaGVja3BvaW50KCdydW5fbWFpbl9vcHRpb25zX2J1aWx0JylcblxuICAvLyAtcC8tLXByaW50IG1vZGU6IHNraXAgc3ViY29tbWFuZCByZWdpc3RyYXRpb24uIFRoZSA1MiBzdWJjb21tYW5kc1xuICAvLyAobWNwLCBhdXRoLCBwbHVnaW4sIHNraWxsLCB0YXNrLCBjb25maWcsIGRvY3RvciwgdXBkYXRlLCBldGMuKSBhcmVcbiAgLy8gbmV2ZXIgZGlzcGF0Y2hlZCBpbiBwcmludCBtb2RlIFx1MjAxNCBjb21tYW5kZXIgcm91dGVzIHRoZSBwcm9tcHQgdG8gdGhlXG4gIC8vIGRlZmF1bHQgYWN0aW9uLiBUaGUgc3ViY29tbWFuZCByZWdpc3RyYXRpb24gcGF0aCB3YXMgbWVhc3VyZWQgYXQgfjY1bXNcbiAgLy8gb24gYmFzZWxpbmUgXHUyMDE0IG1vc3RseSB0aGUgaXNCcmlkZ2VFbmFibGVkKCkgY2FsbCAoMjVtcyBzZXR0aW5ncyBab2QgcGFyc2VcbiAgLy8gKyA0MG1zIHN5bmMga2V5Y2hhaW4gc3VicHJvY2VzcyksIGJvdGggaGlkZGVuIGJ5IHRoZSB0cnkvY2F0Y2ggdGhhdFxuICAvLyBhbHdheXMgcmV0dXJucyBmYWxzZSBiZWZvcmUgZW5hYmxlQ29uZmlncygpLiBjYzovLyBVUkxzIGFyZSByZXdyaXR0ZW4gdG9cbiAgLy8gYG9wZW5gIGF0IG1haW4oKSBsaW5lIH44NTEgQkVGT1JFIHRoaXMgcnVucywgc28gYXJndiBjaGVjayBpcyBzYWZlIGhlcmUuXG4gIGNvbnN0IGlzUHJpbnRNb2RlID1cbiAgICBwcm9jZXNzLmFyZ3YuaW5jbHVkZXMoJy1wJykgfHwgcHJvY2Vzcy5hcmd2LmluY2x1ZGVzKCctLXByaW50JylcbiAgY29uc3QgaXNDY1VybCA9IHByb2Nlc3MuYXJndi5zb21lKFxuICAgIGEgPT4gYS5zdGFydHNXaXRoKCdjYzovLycpIHx8IGEuc3RhcnRzV2l0aCgnY2MrdW5peDovLycpLFxuICApXG4gIGlmIChpc1ByaW50TW9kZSAmJiAhaXNDY1VybCkge1xuICAgIHByb2ZpbGVDaGVja3BvaW50KCdydW5fYmVmb3JlX3BhcnNlJylcbiAgICBhd2FpdCBwcm9ncmFtLnBhcnNlQXN5bmMocHJvY2Vzcy5hcmd2KVxuICAgIHByb2ZpbGVDaGVja3BvaW50KCdydW5fYWZ0ZXJfcGFyc2UnKVxuICAgIHJldHVybiBwcm9ncmFtXG4gIH1cblxuICAvLyBjbGF1ZGUgbWNwXG5cbiAgY29uc3QgbWNwID0gcHJvZ3JhbVxuICAgIC5jb21tYW5kKCdtY3AnKVxuICAgIC5kZXNjcmlwdGlvbignQ29uZmlndXJlIGFuZCBtYW5hZ2UgTUNQIHNlcnZlcnMnKVxuICAgIC5jb25maWd1cmVIZWxwKGNyZWF0ZVNvcnRlZEhlbHBDb25maWcoKSlcbiAgICAuZW5hYmxlUG9zaXRpb25hbE9wdGlvbnMoKVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdzZXJ2ZScpXG4gICAgLmRlc2NyaXB0aW9uKGBTdGFydCB0aGUgQ2xhdWRlIENvZGUgTUNQIHNlcnZlcmApXG4gICAgLm9wdGlvbignLWQsIC0tZGVidWcnLCAnRW5hYmxlIGRlYnVnIG1vZGUnLCAoKSA9PiB0cnVlKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS12ZXJib3NlJyxcbiAgICAgICdPdmVycmlkZSB2ZXJib3NlIG1vZGUgc2V0dGluZyBmcm9tIGNvbmZpZycsXG4gICAgICAoKSA9PiB0cnVlLFxuICAgIClcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKHsgZGVidWcsIHZlcmJvc2UgfTogeyBkZWJ1Zz86IGJvb2xlYW47IHZlcmJvc2U/OiBib29sZWFuIH0pID0+IHtcbiAgICAgICAgY29uc3QgeyBtY3BTZXJ2ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgICAgYXdhaXQgbWNwU2VydmVIYW5kbGVyKHsgZGVidWcsIHZlcmJvc2UgfSlcbiAgICAgIH0sXG4gICAgKVxuXG4gIC8vIFJlZ2lzdGVyIHRoZSBtY3AgYWRkIHN1YmNvbW1hbmQgKGV4dHJhY3RlZCBmb3IgdGVzdGFiaWxpdHkpXG4gIHJlZ2lzdGVyTWNwQWRkQ29tbWFuZChtY3ApXG5cbiAgaWYgKGlzWGFhRW5hYmxlZCgpKSB7XG4gICAgcmVnaXN0ZXJNY3BYYWFJZHBDb21tYW5kKG1jcClcbiAgfVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdyZW1vdmUgPG5hbWU+JylcbiAgICAuZGVzY3JpcHRpb24oJ1JlbW92ZSBhbiBNQ1Agc2VydmVyJylcbiAgICAub3B0aW9uKFxuICAgICAgJy1zLCAtLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ0NvbmZpZ3VyYXRpb24gc2NvcGUgKGxvY2FsLCB1c2VyLCBvciBwcm9qZWN0KSAtIGlmIG5vdCBzcGVjaWZpZWQsIHJlbW92ZXMgZnJvbSB3aGljaGV2ZXIgc2NvcGUgaXQgZXhpc3RzIGluJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAobmFtZTogc3RyaW5nLCBvcHRpb25zOiB7IHNjb3BlPzogc3RyaW5nIH0pID0+IHtcbiAgICAgIGNvbnN0IHsgbWNwUmVtb3ZlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9tY3AuanMnKVxuICAgICAgYXdhaXQgbWNwUmVtb3ZlSGFuZGxlcihuYW1lLCBvcHRpb25zKVxuICAgIH0pXG5cbiAgbWNwXG4gICAgLmNvbW1hbmQoJ2xpc3QnKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICdMaXN0IGNvbmZpZ3VyZWQgTUNQIHNlcnZlcnMuIE5vdGU6IFRoZSB3b3Jrc3BhY2UgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kIHN0ZGlvIHNlcnZlcnMgZnJvbSAubWNwLmpzb24gYXJlIHNwYXduZWQgZm9yIGhlYWx0aCBjaGVja3MuIE9ubHkgdXNlIHRoaXMgY29tbWFuZCBpbiBkaXJlY3RvcmllcyB5b3UgdHJ1c3QuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IG1jcExpc3RIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL21jcC5qcycpXG4gICAgICBhd2FpdCBtY3BMaXN0SGFuZGxlcigpXG4gICAgfSlcblxuICBtY3BcbiAgICAuY29tbWFuZCgnZ2V0IDxuYW1lPicpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0dldCBkZXRhaWxzIGFib3V0IGFuIE1DUCBzZXJ2ZXIuIE5vdGU6IFRoZSB3b3Jrc3BhY2UgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kIHN0ZGlvIHNlcnZlcnMgZnJvbSAubWNwLmpzb24gYXJlIHNwYXduZWQgZm9yIGhlYWx0aCBjaGVja3MuIE9ubHkgdXNlIHRoaXMgY29tbWFuZCBpbiBkaXJlY3RvcmllcyB5b3UgdHJ1c3QuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAobmFtZTogc3RyaW5nKSA9PiB7XG4gICAgICBjb25zdCB7IG1jcEdldEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvbWNwLmpzJylcbiAgICAgIGF3YWl0IG1jcEdldEhhbmRsZXIobmFtZSlcbiAgICB9KVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdhZGQtanNvbiA8bmFtZT4gPGpzb24+JylcbiAgICAuZGVzY3JpcHRpb24oJ0FkZCBhbiBNQ1Agc2VydmVyIChzdGRpbyBvciBTU0UpIHdpdGggYSBKU09OIHN0cmluZycpXG4gICAgLm9wdGlvbihcbiAgICAgICctcywgLS1zY29wZSA8c2NvcGU+JyxcbiAgICAgICdDb25maWd1cmF0aW9uIHNjb3BlIChsb2NhbCwgdXNlciwgb3IgcHJvamVjdCknLFxuICAgICAgJ2xvY2FsJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLWNsaWVudC1zZWNyZXQnLFxuICAgICAgJ1Byb21wdCBmb3IgT0F1dGggY2xpZW50IHNlY3JldCAob3Igc2V0IE1DUF9DTElFTlRfU0VDUkVUIGVudiB2YXIpJyxcbiAgICApXG4gICAgLmFjdGlvbihcbiAgICAgIGFzeW5jIChcbiAgICAgICAgbmFtZTogc3RyaW5nLFxuICAgICAgICBqc29uOiBzdHJpbmcsXG4gICAgICAgIG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmc7IGNsaWVudFNlY3JldD86IHRydWUgfSxcbiAgICAgICkgPT4ge1xuICAgICAgICBjb25zdCB7IG1jcEFkZEpzb25IYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL21jcC5qcycpXG4gICAgICAgIGF3YWl0IG1jcEFkZEpzb25IYW5kbGVyKG5hbWUsIGpzb24sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICBtY3BcbiAgICAuY29tbWFuZCgnYWRkLWZyb20tY2xhdWRlLWRlc2t0b3AnKVxuICAgIC5kZXNjcmlwdGlvbignSW1wb3J0IE1DUCBzZXJ2ZXJzIGZyb20gQ2xhdWRlIERlc2t0b3AgKE1hYyBhbmQgV1NMIG9ubHkpJylcbiAgICAub3B0aW9uKFxuICAgICAgJy1zLCAtLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ0NvbmZpZ3VyYXRpb24gc2NvcGUgKGxvY2FsLCB1c2VyLCBvciBwcm9qZWN0KScsXG4gICAgICAnbG9jYWwnLFxuICAgIClcbiAgICAuYWN0aW9uKGFzeW5jIChvcHRpb25zOiB7IHNjb3BlPzogc3RyaW5nIH0pID0+IHtcbiAgICAgIGNvbnN0IHsgbWNwQWRkRnJvbURlc2t0b3BIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL21jcC5qcycpXG4gICAgICBhd2FpdCBtY3BBZGRGcm9tRGVza3RvcEhhbmRsZXIob3B0aW9ucylcbiAgICB9KVxuXG4gIG1jcFxuICAgIC5jb21tYW5kKCdyZXNldC1wcm9qZWN0LWNob2ljZXMnKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICdSZXNldCBhbGwgYXBwcm92ZWQgYW5kIHJlamVjdGVkIHByb2plY3Qtc2NvcGVkICgubWNwLmpzb24pIHNlcnZlcnMgd2l0aGluIHRoaXMgcHJvamVjdCcsXG4gICAgKVxuICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgeyBtY3BSZXNldENob2ljZXNIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL21jcC5qcycpXG4gICAgICBhd2FpdCBtY3BSZXNldENob2ljZXNIYW5kbGVyKClcbiAgICB9KVxuXG4gIC8vIGNsYXVkZSBzZXJ2ZXJcbiAgaWYgKGZlYXR1cmUoJ0RJUkVDVF9DT05ORUNUJykpIHtcbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnc2VydmVyJylcbiAgICAgIC5kZXNjcmlwdGlvbignU3RhcnQgYSBDbGF1ZGUgQ29kZSBzZXNzaW9uIHNlcnZlcicpXG4gICAgICAub3B0aW9uKCctLXBvcnQgPG51bWJlcj4nLCAnSFRUUCBwb3J0JywgJzAnKVxuICAgICAgLm9wdGlvbignLS1ob3N0IDxzdHJpbmc+JywgJ0JpbmQgYWRkcmVzcycsICcwLjAuMC4wJylcbiAgICAgIC5vcHRpb24oJy0tYXV0aC10b2tlbiA8dG9rZW4+JywgJ0JlYXJlciB0b2tlbiBmb3IgYXV0aCcpXG4gICAgICAub3B0aW9uKCctLXVuaXggPHBhdGg+JywgJ0xpc3RlbiBvbiBhIHVuaXggZG9tYWluIHNvY2tldCcpXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS13b3Jrc3BhY2UgPGRpcj4nLFxuICAgICAgICAnRGVmYXVsdCB3b3JraW5nIGRpcmVjdG9yeSBmb3Igc2Vzc2lvbnMgdGhhdCBkbyBub3Qgc3BlY2lmeSBjd2QnLFxuICAgICAgKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0taWRsZS10aW1lb3V0IDxtcz4nLFxuICAgICAgICAnSWRsZSB0aW1lb3V0IGZvciBkZXRhY2hlZCBzZXNzaW9ucyBpbiBtcyAoMCA9IG5ldmVyIGV4cGlyZSknLFxuICAgICAgICAnNjAwMDAwJyxcbiAgICAgIClcbiAgICAgIC5vcHRpb24oXG4gICAgICAgICctLW1heC1zZXNzaW9ucyA8bj4nLFxuICAgICAgICAnTWF4aW11bSBjb25jdXJyZW50IHNlc3Npb25zICgwID0gdW5saW1pdGVkKScsXG4gICAgICAgICczMicsXG4gICAgICApXG4gICAgICAuYWN0aW9uKFxuICAgICAgICBhc3luYyAob3B0czoge1xuICAgICAgICAgIHBvcnQ6IHN0cmluZ1xuICAgICAgICAgIGhvc3Q6IHN0cmluZ1xuICAgICAgICAgIGF1dGhUb2tlbj86IHN0cmluZ1xuICAgICAgICAgIHVuaXg/OiBzdHJpbmdcbiAgICAgICAgICB3b3Jrc3BhY2U/OiBzdHJpbmdcbiAgICAgICAgICBpZGxlVGltZW91dDogc3RyaW5nXG4gICAgICAgICAgbWF4U2Vzc2lvbnM6IHN0cmluZ1xuICAgICAgICB9KSA9PiB7XG4gICAgICAgICAgY29uc3QgeyByYW5kb21CeXRlcyB9ID0gYXdhaXQgaW1wb3J0KCdjcnlwdG8nKVxuICAgICAgICAgIGNvbnN0IHsgc3RhcnRTZXJ2ZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9zZXJ2ZXIvc2VydmVyLmpzJylcbiAgICAgICAgICBjb25zdCB7IFNlc3Npb25NYW5hZ2VyIH0gPSBhd2FpdCBpbXBvcnQoJy4vc2VydmVyL3Nlc3Npb25NYW5hZ2VyLmpzJylcbiAgICAgICAgICBjb25zdCB7IERhbmdlcm91c0JhY2tlbmQgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAgICcuL3NlcnZlci9iYWNrZW5kcy9kYW5nZXJvdXNCYWNrZW5kLmpzJ1xuICAgICAgICAgIClcbiAgICAgICAgICBjb25zdCB7IHByaW50QmFubmVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vc2VydmVyL3NlcnZlckJhbm5lci5qcycpXG4gICAgICAgICAgY29uc3QgeyBjcmVhdGVTZXJ2ZXJMb2dnZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9zZXJ2ZXIvc2VydmVyTG9nLmpzJylcbiAgICAgICAgICBjb25zdCB7IHdyaXRlU2VydmVyTG9jaywgcmVtb3ZlU2VydmVyTG9jaywgcHJvYmVSdW5uaW5nU2VydmVyIH0gPVxuICAgICAgICAgICAgYXdhaXQgaW1wb3J0KCcuL3NlcnZlci9sb2NrZmlsZS5qcycpXG5cbiAgICAgICAgICBjb25zdCBleGlzdGluZyA9IGF3YWl0IHByb2JlUnVubmluZ1NlcnZlcigpXG4gICAgICAgICAgaWYgKGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAgICAgYEEgY2xhdWRlIHNlcnZlciBpcyBhbHJlYWR5IHJ1bm5pbmcgKHBpZCAke2V4aXN0aW5nLnBpZH0pIGF0ICR7ZXhpc3RpbmcuaHR0cFVybH1cXG5gLFxuICAgICAgICAgICAgKVxuICAgICAgICAgICAgcHJvY2Vzcy5leGl0KDEpXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgY29uc3QgYXV0aFRva2VuID1cbiAgICAgICAgICAgIG9wdHMuYXV0aFRva2VuID8/XG4gICAgICAgICAgICBgc2stYW50LWNjLSR7cmFuZG9tQnl0ZXMoMTYpLnRvU3RyaW5nKCdiYXNlNjR1cmwnKX1gXG5cbiAgICAgICAgICBjb25zdCBjb25maWcgPSB7XG4gICAgICAgICAgICBwb3J0OiBwYXJzZUludChvcHRzLnBvcnQsIDEwKSxcbiAgICAgICAgICAgIGhvc3Q6IG9wdHMuaG9zdCxcbiAgICAgICAgICAgIGF1dGhUb2tlbixcbiAgICAgICAgICAgIHVuaXg6IG9wdHMudW5peCxcbiAgICAgICAgICAgIHdvcmtzcGFjZTogb3B0cy53b3Jrc3BhY2UsXG4gICAgICAgICAgICBpZGxlVGltZW91dE1zOiBwYXJzZUludChvcHRzLmlkbGVUaW1lb3V0LCAxMCksXG4gICAgICAgICAgICBtYXhTZXNzaW9uczogcGFyc2VJbnQob3B0cy5tYXhTZXNzaW9ucywgMTApLFxuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnN0IGJhY2tlbmQgPSBuZXcgRGFuZ2Vyb3VzQmFja2VuZCgpXG4gICAgICAgICAgY29uc3Qgc2Vzc2lvbk1hbmFnZXIgPSBuZXcgU2Vzc2lvbk1hbmFnZXIoYmFja2VuZCwge1xuICAgICAgICAgICAgaWRsZVRpbWVvdXRNczogY29uZmlnLmlkbGVUaW1lb3V0TXMsXG4gICAgICAgICAgICBtYXhTZXNzaW9uczogY29uZmlnLm1heFNlc3Npb25zLFxuICAgICAgICAgIH0pXG4gICAgICAgICAgY29uc3QgbG9nZ2VyID0gY3JlYXRlU2VydmVyTG9nZ2VyKClcblxuICAgICAgICAgIGNvbnN0IHNlcnZlciA9IHN0YXJ0U2VydmVyKGNvbmZpZywgc2Vzc2lvbk1hbmFnZXIsIGxvZ2dlcilcbiAgICAgICAgICBjb25zdCBhY3R1YWxQb3J0ID0gc2VydmVyLnBvcnQgPz8gY29uZmlnLnBvcnRcbiAgICAgICAgICBwcmludEJhbm5lcihjb25maWcsIGF1dGhUb2tlbiwgYWN0dWFsUG9ydClcblxuICAgICAgICAgIGF3YWl0IHdyaXRlU2VydmVyTG9jayh7XG4gICAgICAgICAgICBwaWQ6IHByb2Nlc3MucGlkLFxuICAgICAgICAgICAgcG9ydDogYWN0dWFsUG9ydCxcbiAgICAgICAgICAgIGhvc3Q6IGNvbmZpZy5ob3N0LFxuICAgICAgICAgICAgaHR0cFVybDogY29uZmlnLnVuaXhcbiAgICAgICAgICAgICAgPyBgdW5peDoke2NvbmZpZy51bml4fWBcbiAgICAgICAgICAgICAgOiBgaHR0cDovLyR7Y29uZmlnLmhvc3R9OiR7YWN0dWFsUG9ydH1gLFxuICAgICAgICAgICAgc3RhcnRlZEF0OiBEYXRlLm5vdygpLFxuICAgICAgICAgIH0pXG5cbiAgICAgICAgICBsZXQgc2h1dHRpbmdEb3duID0gZmFsc2VcbiAgICAgICAgICBjb25zdCBzaHV0ZG93biA9IGFzeW5jICgpID0+IHtcbiAgICAgICAgICAgIGlmIChzaHV0dGluZ0Rvd24pIHJldHVyblxuICAgICAgICAgICAgc2h1dHRpbmdEb3duID0gdHJ1ZVxuICAgICAgICAgICAgLy8gU3RvcCBhY2NlcHRpbmcgbmV3IGNvbm5lY3Rpb25zIGJlZm9yZSB0ZWFyaW5nIGRvd24gc2Vzc2lvbnMuXG4gICAgICAgICAgICBzZXJ2ZXIuc3RvcCh0cnVlKVxuICAgICAgICAgICAgYXdhaXQgc2Vzc2lvbk1hbmFnZXIuZGVzdHJveUFsbCgpXG4gICAgICAgICAgICBhd2FpdCByZW1vdmVTZXJ2ZXJMb2NrKClcbiAgICAgICAgICAgIHByb2Nlc3MuZXhpdCgwKVxuICAgICAgICAgIH1cbiAgICAgICAgICBwcm9jZXNzLm9uY2UoJ1NJR0lOVCcsICgpID0+IHZvaWQgc2h1dGRvd24oKSlcbiAgICAgICAgICBwcm9jZXNzLm9uY2UoJ1NJR1RFUk0nLCAoKSA9PiB2b2lkIHNodXRkb3duKCkpXG4gICAgICAgIH0sXG4gICAgICApXG4gIH1cblxuICAvLyBgY2xhdWRlIHNzaCA8aG9zdD4gW2Rpcl1gIFx1MjAxNCByZWdpc3RlcmVkIGhlcmUgb25seSBzbyAtLWhlbHAgc2hvd3MgaXQuXG4gIC8vIFRoZSBhY3R1YWwgaW50ZXJhY3RpdmUgZmxvdyBpcyBoYW5kbGVkIGJ5IGVhcmx5IGFyZ3YgcmV3cml0aW5nIGluIG1haW4oKVxuICAvLyAocGFyYWxsZWxzIHRoZSBESVJFQ1RfQ09OTkVDVC9jYzovLyBwYXR0ZXJuIGFib3ZlKS4gSWYgY29tbWFuZGVyIHJlYWNoZXNcbiAgLy8gdGhpcyBhY3Rpb24gaXQgbWVhbnMgdGhlIGFyZ3YgcmV3cml0ZSBkaWRuJ3QgZmlyZSAoZS5nLiB1c2VyIHJhblxuICAvLyBgY2xhdWRlIHNzaGAgd2l0aCBubyBob3N0KSBcdTIwMTQganVzdCBwcmludCB1c2FnZS5cbiAgaWYgKGZlYXR1cmUoJ1NTSF9SRU1PVEUnKSkge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdzc2ggPGhvc3Q+IFtkaXJdJylcbiAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgJ1J1biBDbGF1ZGUgQ29kZSBvbiBhIHJlbW90ZSBob3N0IG92ZXIgU1NILiBEZXBsb3lzIHRoZSBiaW5hcnkgYW5kICcgK1xuICAgICAgICAgICd0dW5uZWxzIEFQSSBhdXRoIGJhY2sgdGhyb3VnaCB5b3VyIGxvY2FsIG1hY2hpbmUgXHUyMDE0IG5vIHJlbW90ZSBzZXR1cCBuZWVkZWQuJyxcbiAgICAgIClcbiAgICAgIC5vcHRpb24oXG4gICAgICAgICctLXBlcm1pc3Npb24tbW9kZSA8bW9kZT4nLFxuICAgICAgICAnUGVybWlzc2lvbiBtb2RlIGZvciB0aGUgcmVtb3RlIHNlc3Npb24nLFxuICAgICAgKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tZGFuZ2Vyb3VzbHktc2tpcC1wZXJtaXNzaW9ucycsXG4gICAgICAgICdTa2lwIGFsbCBwZXJtaXNzaW9uIHByb21wdHMgb24gdGhlIHJlbW90ZSAoZGFuZ2Vyb3VzKScsXG4gICAgICApXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS1sb2NhbCcsXG4gICAgICAgICdlMmUgdGVzdCBtb2RlIFx1MjAxNCBzcGF3biB0aGUgY2hpbGQgQ0xJIGxvY2FsbHkgKHNraXAgc3NoL2RlcGxveSkuICcgK1xuICAgICAgICAgICdFeGVyY2lzZXMgdGhlIGF1dGggcHJveHkgYW5kIHVuaXgtc29ja2V0IHBsdW1iaW5nIHdpdGhvdXQgYSByZW1vdGUgaG9zdC4nLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICAgIC8vIEFyZ3YgcmV3cml0aW5nIGluIG1haW4oKSBzaG91bGQgaGF2ZSBjb25zdW1lZCBgc3NoIDxob3N0PmAgYmVmb3JlXG4gICAgICAgIC8vIGNvbW1hbmRlciBydW5zLiBSZWFjaGluZyBoZXJlIG1lYW5zIGhvc3Qgd2FzIG1pc3Npbmcgb3IgdGhlXG4gICAgICAgIC8vIHJld3JpdGUgcHJlZGljYXRlIGRpZG4ndCBtYXRjaC5cbiAgICAgICAgcHJvY2Vzcy5zdGRlcnIud3JpdGUoXG4gICAgICAgICAgJ1VzYWdlOiBjbGF1ZGUgc3NoIDx1c2VyQGhvc3QgfCBzc2gtY29uZmlnLWFsaWFzPiBbZGlyXVxcblxcbicgK1xuICAgICAgICAgICAgXCJSdW5zIENsYXVkZSBDb2RlIG9uIGEgcmVtb3RlIExpbnV4IGhvc3QuIFlvdSBkb24ndCBuZWVkIHRvIGluc3RhbGxcXG5cIiArXG4gICAgICAgICAgICAnYW55dGhpbmcgb24gdGhlIHJlbW90ZSBvciBydW4gYGNsYXVkZSBhdXRoIGxvZ2luYCB0aGVyZSBcdTIwMTQgdGhlIGJpbmFyeSBpc1xcbicgK1xuICAgICAgICAgICAgJ2RlcGxveWVkIG92ZXIgU1NIIGFuZCBBUEkgYXV0aCB0dW5uZWxzIGJhY2sgdGhyb3VnaCB5b3VyIGxvY2FsIG1hY2hpbmUuXFxuJyxcbiAgICAgICAgKVxuICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgIH0pXG4gIH1cblxuICAvLyBjbGF1ZGUgY29ubmVjdCBcdTIwMTQgc3ViY29tbWFuZCBvbmx5IGhhbmRsZXMgLXAgKGhlYWRsZXNzKSBtb2RlLlxuICAvLyBJbnRlcmFjdGl2ZSBtb2RlICh3aXRob3V0IC1wKSBpcyBoYW5kbGVkIGJ5IGVhcmx5IGFyZ3YgcmV3cml0aW5nIGluIG1haW4oKVxuICAvLyB3aGljaCByZWRpcmVjdHMgdG8gdGhlIG1haW4gY29tbWFuZCB3aXRoIGZ1bGwgVFVJIHN1cHBvcnQuXG4gIGlmIChmZWF0dXJlKCdESVJFQ1RfQ09OTkVDVCcpKSB7XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ29wZW4gPGNjLXVybD4nKVxuICAgICAgLmRlc2NyaXB0aW9uKFxuICAgICAgICAnQ29ubmVjdCB0byBhIENsYXVkZSBDb2RlIHNlcnZlciAoaW50ZXJuYWwgXHUyMDE0IHVzZSBjYzovLyBVUkxzKScsXG4gICAgICApXG4gICAgICAub3B0aW9uKCctcCwgLS1wcmludCBbcHJvbXB0XScsICdQcmludCBtb2RlIChoZWFkbGVzcyknKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tb3V0cHV0LWZvcm1hdCA8Zm9ybWF0PicsXG4gICAgICAgICdPdXRwdXQgZm9ybWF0OiB0ZXh0LCBqc29uLCBzdHJlYW0tanNvbicsXG4gICAgICAgICd0ZXh0JyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oXG4gICAgICAgIGFzeW5jIChcbiAgICAgICAgICBjY1VybDogc3RyaW5nLFxuICAgICAgICAgIG9wdHM6IHtcbiAgICAgICAgICAgIHByaW50Pzogc3RyaW5nIHwgYm9vbGVhblxuICAgICAgICAgICAgb3V0cHV0Rm9ybWF0OiBzdHJpbmdcbiAgICAgICAgICB9LFxuICAgICAgICApID0+IHtcbiAgICAgICAgICBjb25zdCB7IHBhcnNlQ29ubmVjdFVybCB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICAgJy4vc2VydmVyL3BhcnNlQ29ubmVjdFVybC5qcydcbiAgICAgICAgICApXG4gICAgICAgICAgY29uc3QgeyBzZXJ2ZXJVcmwsIGF1dGhUb2tlbiB9ID0gcGFyc2VDb25uZWN0VXJsKGNjVXJsKVxuXG4gICAgICAgICAgbGV0IGNvbm5lY3RDb25maWdcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IGNyZWF0ZURpcmVjdENvbm5lY3RTZXNzaW9uKHtcbiAgICAgICAgICAgICAgc2VydmVyVXJsLFxuICAgICAgICAgICAgICBhdXRoVG9rZW4sXG4gICAgICAgICAgICAgIGN3ZDogZ2V0T3JpZ2luYWxDd2QoKSxcbiAgICAgICAgICAgICAgZGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnM6XG4gICAgICAgICAgICAgICAgX3BlbmRpbmdDb25uZWN0Py5kYW5nZXJvdXNseVNraXBQZXJtaXNzaW9ucyxcbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgICBpZiAoc2Vzc2lvbi53b3JrRGlyKSB7XG4gICAgICAgICAgICAgIHNldE9yaWdpbmFsQ3dkKHNlc3Npb24ud29ya0RpcilcbiAgICAgICAgICAgICAgc2V0Q3dkU3RhdGUoc2Vzc2lvbi53b3JrRGlyKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2V0RGlyZWN0Q29ubmVjdFNlcnZlclVybChzZXJ2ZXJVcmwpXG4gICAgICAgICAgICBjb25uZWN0Q29uZmlnID0gc2Vzc2lvbi5jb25maWdcbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIC8vIGJpb21lLWlnbm9yZSBsaW50L3N1c3BpY2lvdXMvbm9Db25zb2xlOiBpbnRlbnRpb25hbCBlcnJvciBvdXRwdXRcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgICAgIGVyciBpbnN0YW5jZW9mIERpcmVjdENvbm5lY3RFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksXG4gICAgICAgICAgICApXG4gICAgICAgICAgICBwcm9jZXNzLmV4aXQoMSlcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCB7IHJ1bkNvbm5lY3RIZWFkbGVzcyB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICAgJy4vc2VydmVyL2Nvbm5lY3RIZWFkbGVzcy5qcydcbiAgICAgICAgICApXG5cbiAgICAgICAgICBjb25zdCBwcm9tcHQgPSB0eXBlb2Ygb3B0cy5wcmludCA9PT0gJ3N0cmluZycgPyBvcHRzLnByaW50IDogJydcbiAgICAgICAgICBjb25zdCBpbnRlcmFjdGl2ZSA9IG9wdHMucHJpbnQgPT09IHRydWVcbiAgICAgICAgICBhd2FpdCBydW5Db25uZWN0SGVhZGxlc3MoXG4gICAgICAgICAgICBjb25uZWN0Q29uZmlnLFxuICAgICAgICAgICAgcHJvbXB0LFxuICAgICAgICAgICAgb3B0cy5vdXRwdXRGb3JtYXQsXG4gICAgICAgICAgICBpbnRlcmFjdGl2ZSxcbiAgICAgICAgICApXG4gICAgICAgIH0sXG4gICAgICApXG4gIH1cblxuICAvLyBjbGF1ZGUgYXV0aFxuXG4gIGNvbnN0IGF1dGggPSBwcm9ncmFtXG4gICAgLmNvbW1hbmQoJ2F1dGgnKVxuICAgIC5kZXNjcmlwdGlvbignTWFuYWdlIGF1dGhlbnRpY2F0aW9uJylcbiAgICAuY29uZmlndXJlSGVscChjcmVhdGVTb3J0ZWRIZWxwQ29uZmlnKCkpXG5cbiAgYXV0aFxuICAgIC5jb21tYW5kKCdsb2dpbicpXG4gICAgLmRlc2NyaXB0aW9uKCdTaWduIGluIHRvIHlvdXIgQW50aHJvcGljIGFjY291bnQnKVxuICAgIC5vcHRpb24oJy0tZW1haWwgPGVtYWlsPicsICdQcmUtcG9wdWxhdGUgZW1haWwgYWRkcmVzcyBvbiB0aGUgbG9naW4gcGFnZScpXG4gICAgLm9wdGlvbignLS1zc28nLCAnRm9yY2UgU1NPIGxvZ2luIGZsb3cnKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1jb25zb2xlJyxcbiAgICAgICdVc2UgQW50aHJvcGljIENvbnNvbGUgKEFQSSB1c2FnZSBiaWxsaW5nKSBpbnN0ZWFkIG9mIENsYXVkZSBzdWJzY3JpcHRpb24nLFxuICAgIClcbiAgICAub3B0aW9uKCctLWNsYXVkZWFpJywgJ1VzZSBDbGF1ZGUgc3Vic2NyaXB0aW9uIChkZWZhdWx0KScpXG4gICAgLmFjdGlvbihcbiAgICAgIGFzeW5jICh7XG4gICAgICAgIGVtYWlsLFxuICAgICAgICBzc28sXG4gICAgICAgIGNvbnNvbGU6IHVzZUNvbnNvbGUsXG4gICAgICAgIGNsYXVkZWFpLFxuICAgICAgfToge1xuICAgICAgICBlbWFpbD86IHN0cmluZ1xuICAgICAgICBzc28/OiBib29sZWFuXG4gICAgICAgIGNvbnNvbGU/OiBib29sZWFuXG4gICAgICAgIGNsYXVkZWFpPzogYm9vbGVhblxuICAgICAgfSkgPT4ge1xuICAgICAgICBjb25zdCB7IGF1dGhMb2dpbiB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hdXRoLmpzJylcbiAgICAgICAgYXdhaXQgYXV0aExvZ2luKHsgZW1haWwsIHNzbywgY29uc29sZTogdXNlQ29uc29sZSwgY2xhdWRlYWkgfSlcbiAgICAgIH0sXG4gICAgKVxuXG4gIGF1dGhcbiAgICAuY29tbWFuZCgnc3RhdHVzJylcbiAgICAuZGVzY3JpcHRpb24oJ1Nob3cgYXV0aGVudGljYXRpb24gc3RhdHVzJylcbiAgICAub3B0aW9uKCctLWpzb24nLCAnT3V0cHV0IGFzIEpTT04gKGRlZmF1bHQpJylcbiAgICAub3B0aW9uKCctLXRleHQnLCAnT3V0cHV0IGFzIGh1bWFuLXJlYWRhYmxlIHRleHQnKVxuICAgIC5hY3Rpb24oYXN5bmMgKG9wdHM6IHsganNvbj86IGJvb2xlYW47IHRleHQ/OiBib29sZWFuIH0pID0+IHtcbiAgICAgIGNvbnN0IHsgYXV0aFN0YXR1cyB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hdXRoLmpzJylcbiAgICAgIGF3YWl0IGF1dGhTdGF0dXMob3B0cylcbiAgICB9KVxuXG4gIGF1dGhcbiAgICAuY29tbWFuZCgnbG9nb3V0JylcbiAgICAuZGVzY3JpcHRpb24oJ0xvZyBvdXQgZnJvbSB5b3VyIEFudGhyb3BpYyBhY2NvdW50JylcbiAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgYXV0aExvZ291dCB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hdXRoLmpzJylcbiAgICAgIGF3YWl0IGF1dGhMb2dvdXQoKVxuICAgIH0pXG5cbiAgLyoqXG4gICAqIEhlbHBlciBmdW5jdGlvbiB0byBoYW5kbGUgbWFya2V0cGxhY2UgY29tbWFuZCBlcnJvcnMgY29uc2lzdGVudGx5LlxuICAgKiBMb2dzIHRoZSBlcnJvciBhbmQgZXhpdHMgdGhlIHByb2Nlc3Mgd2l0aCBzdGF0dXMgMS5cbiAgICogQHBhcmFtIGVycm9yIFRoZSBlcnJvciB0aGF0IG9jY3VycmVkXG4gICAqIEBwYXJhbSBhY3Rpb24gRGVzY3JpcHRpb24gb2YgdGhlIGFjdGlvbiB0aGF0IGZhaWxlZFxuICAgKi9cbiAgLy8gSGlkZGVuIGZsYWcgb24gYWxsIHBsdWdpbi9tYXJrZXRwbGFjZSBzdWJjb21tYW5kcyB0byB0YXJnZXQgY293b3JrX3BsdWdpbnMuXG4gIGNvbnN0IGNvd29ya09wdGlvbiA9ICgpID0+XG4gICAgbmV3IE9wdGlvbignLS1jb3dvcmsnLCAnVXNlIGNvd29ya19wbHVnaW5zIGRpcmVjdG9yeScpLmhpZGVIZWxwKClcblxuICAvLyBQbHVnaW4gdmFsaWRhdGUgY29tbWFuZFxuICBjb25zdCBwbHVnaW5DbWQgPSBwcm9ncmFtXG4gICAgLmNvbW1hbmQoJ3BsdWdpbicpXG4gICAgLmFsaWFzKCdwbHVnaW5zJylcbiAgICAuZGVzY3JpcHRpb24oJ01hbmFnZSBDbGF1ZGUgQ29kZSBwbHVnaW5zJylcbiAgICAuY29uZmlndXJlSGVscChjcmVhdGVTb3J0ZWRIZWxwQ29uZmlnKCkpXG5cbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ3ZhbGlkYXRlIDxwYXRoPicpXG4gICAgLmRlc2NyaXB0aW9uKCdWYWxpZGF0ZSBhIHBsdWdpbiBvciBtYXJrZXRwbGFjZSBtYW5pZmVzdCcpXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKGFzeW5jIChtYW5pZmVzdFBhdGg6IHN0cmluZywgb3B0aW9uczogeyBjb3dvcms/OiBib29sZWFuIH0pID0+IHtcbiAgICAgIGNvbnN0IHsgcGx1Z2luVmFsaWRhdGVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICcuL2NsaS9oYW5kbGVycy9wbHVnaW5zLmpzJ1xuICAgICAgKVxuICAgICAgYXdhaXQgcGx1Z2luVmFsaWRhdGVIYW5kbGVyKG1hbmlmZXN0UGF0aCwgb3B0aW9ucylcbiAgICB9KVxuXG4gIC8vIFBsdWdpbiBsaXN0IGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ2xpc3QnKVxuICAgIC5kZXNjcmlwdGlvbignTGlzdCBpbnN0YWxsZWQgcGx1Z2lucycpXG4gICAgLm9wdGlvbignLS1qc29uJywgJ091dHB1dCBhcyBKU09OJylcbiAgICAub3B0aW9uKFxuICAgICAgJy0tYXZhaWxhYmxlJyxcbiAgICAgICdJbmNsdWRlIGF2YWlsYWJsZSBwbHVnaW5zIGZyb20gbWFya2V0cGxhY2VzIChyZXF1aXJlcyAtLWpzb24pJyxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKG9wdGlvbnM6IHtcbiAgICAgICAganNvbj86IGJvb2xlYW5cbiAgICAgICAgYXZhaWxhYmxlPzogYm9vbGVhblxuICAgICAgICBjb3dvcms/OiBib29sZWFuXG4gICAgICB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgcGx1Z2luTGlzdEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcycpXG4gICAgICAgIGF3YWl0IHBsdWdpbkxpc3RIYW5kbGVyKG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBNYXJrZXRwbGFjZSBzdWJjb21tYW5kc1xuICBjb25zdCBtYXJrZXRwbGFjZUNtZCA9IHBsdWdpbkNtZFxuICAgIC5jb21tYW5kKCdtYXJrZXRwbGFjZScpXG4gICAgLmRlc2NyaXB0aW9uKCdNYW5hZ2UgQ2xhdWRlIENvZGUgbWFya2V0cGxhY2VzJylcbiAgICAuY29uZmlndXJlSGVscChjcmVhdGVTb3J0ZWRIZWxwQ29uZmlnKCkpXG5cbiAgbWFya2V0cGxhY2VDbWRcbiAgICAuY29tbWFuZCgnYWRkIDxzb3VyY2U+JylcbiAgICAuZGVzY3JpcHRpb24oJ0FkZCBhIG1hcmtldHBsYWNlIGZyb20gYSBVUkwsIHBhdGgsIG9yIEdpdEh1YiByZXBvJylcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1zcGFyc2UgPHBhdGhzLi4uPicsXG4gICAgICAnTGltaXQgY2hlY2tvdXQgdG8gc3BlY2lmaWMgZGlyZWN0b3JpZXMgdmlhIGdpdCBzcGFyc2UtY2hlY2tvdXQgKGZvciBtb25vcmVwb3MpLiBFeGFtcGxlOiAtLXNwYXJzZSAuY2xhdWRlLXBsdWdpbiBwbHVnaW5zJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ1doZXJlIHRvIGRlY2xhcmUgdGhlIG1hcmtldHBsYWNlOiB1c2VyIChkZWZhdWx0KSwgcHJvamVjdCwgb3IgbG9jYWwnLFxuICAgIClcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBzb3VyY2U6IHN0cmluZyxcbiAgICAgICAgb3B0aW9uczogeyBjb3dvcms/OiBib29sZWFuOyBzcGFyc2U/OiBzdHJpbmdbXTsgc2NvcGU/OiBzdHJpbmcgfSxcbiAgICAgICkgPT4ge1xuICAgICAgICBjb25zdCB7IG1hcmtldHBsYWNlQWRkSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KFxuICAgICAgICAgICcuL2NsaS9oYW5kbGVycy9wbHVnaW5zLmpzJ1xuICAgICAgICApXG4gICAgICAgIGF3YWl0IG1hcmtldHBsYWNlQWRkSGFuZGxlcihzb3VyY2UsIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICBtYXJrZXRwbGFjZUNtZFxuICAgIC5jb21tYW5kKCdsaXN0JylcbiAgICAuZGVzY3JpcHRpb24oJ0xpc3QgYWxsIGNvbmZpZ3VyZWQgbWFya2V0cGxhY2VzJylcbiAgICAub3B0aW9uKCctLWpzb24nLCAnT3V0cHV0IGFzIEpTT04nKVxuICAgIC5hZGRPcHRpb24oY293b3JrT3B0aW9uKCkpXG4gICAgLmFjdGlvbihhc3luYyAob3B0aW9uczogeyBqc29uPzogYm9vbGVhbjsgY293b3JrPzogYm9vbGVhbiB9KSA9PiB7XG4gICAgICBjb25zdCB7IG1hcmtldHBsYWNlTGlzdEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICApXG4gICAgICBhd2FpdCBtYXJrZXRwbGFjZUxpc3RIYW5kbGVyKG9wdGlvbnMpXG4gICAgfSlcblxuICBtYXJrZXRwbGFjZUNtZFxuICAgIC5jb21tYW5kKCdyZW1vdmUgPG5hbWU+JylcbiAgICAuYWxpYXMoJ3JtJylcbiAgICAuZGVzY3JpcHRpb24oJ1JlbW92ZSBhIGNvbmZpZ3VyZWQgbWFya2V0cGxhY2UnKVxuICAgIC5hZGRPcHRpb24oY293b3JrT3B0aW9uKCkpXG4gICAgLmFjdGlvbihhc3luYyAobmFtZTogc3RyaW5nLCBvcHRpb25zOiB7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgY29uc3QgeyBtYXJrZXRwbGFjZVJlbW92ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICApXG4gICAgICBhd2FpdCBtYXJrZXRwbGFjZVJlbW92ZUhhbmRsZXIobmFtZSwgb3B0aW9ucylcbiAgICB9KVxuXG4gIG1hcmtldHBsYWNlQ21kXG4gICAgLmNvbW1hbmQoJ3VwZGF0ZSBbbmFtZV0nKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICdVcGRhdGUgbWFya2V0cGxhY2UocykgZnJvbSB0aGVpciBzb3VyY2UgLSB1cGRhdGVzIGFsbCBpZiBubyBuYW1lIHNwZWNpZmllZCcsXG4gICAgKVxuICAgIC5hZGRPcHRpb24oY293b3JrT3B0aW9uKCkpXG4gICAgLmFjdGlvbihhc3luYyAobmFtZTogc3RyaW5nIHwgdW5kZWZpbmVkLCBvcHRpb25zOiB7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgY29uc3QgeyBtYXJrZXRwbGFjZVVwZGF0ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICApXG4gICAgICBhd2FpdCBtYXJrZXRwbGFjZVVwZGF0ZUhhbmRsZXIobmFtZSwgb3B0aW9ucylcbiAgICB9KVxuXG4gIC8vIFBsdWdpbiBpbnN0YWxsIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ2luc3RhbGwgPHBsdWdpbj4nKVxuICAgIC5hbGlhcygnaScpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0luc3RhbGwgYSBwbHVnaW4gZnJvbSBhdmFpbGFibGUgbWFya2V0cGxhY2VzICh1c2UgcGx1Z2luQG1hcmtldHBsYWNlIGZvciBzcGVjaWZpYyBtYXJrZXRwbGFjZSknLFxuICAgIClcbiAgICAub3B0aW9uKFxuICAgICAgJy1zLCAtLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ0luc3RhbGxhdGlvbiBzY29wZTogdXNlciwgcHJvamVjdCwgb3IgbG9jYWwnLFxuICAgICAgJ3VzZXInLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAocGx1Z2luOiBzdHJpbmcsIG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmc7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgICBjb25zdCB7IHBsdWdpbkluc3RhbGxIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgcGx1Z2luSW5zdGFsbEhhbmRsZXIocGx1Z2luLCBvcHRpb25zKVxuICAgICAgfSxcbiAgICApXG5cbiAgLy8gUGx1Z2luIHVuaW5zdGFsbCBjb21tYW5kXG4gIHBsdWdpbkNtZFxuICAgIC5jb21tYW5kKCd1bmluc3RhbGwgPHBsdWdpbj4nKVxuICAgIC5hbGlhcygncmVtb3ZlJylcbiAgICAuYWxpYXMoJ3JtJylcbiAgICAuZGVzY3JpcHRpb24oJ1VuaW5zdGFsbCBhbiBpbnN0YWxsZWQgcGx1Z2luJylcbiAgICAub3B0aW9uKFxuICAgICAgJy1zLCAtLXNjb3BlIDxzY29wZT4nLFxuICAgICAgJ1VuaW5zdGFsbCBmcm9tIHNjb3BlOiB1c2VyLCBwcm9qZWN0LCBvciBsb2NhbCcsXG4gICAgICAndXNlcicsXG4gICAgKVxuICAgIC5vcHRpb24oXG4gICAgICAnLS1rZWVwLWRhdGEnLFxuICAgICAgXCJQcmVzZXJ2ZSB0aGUgcGx1Z2luJ3MgcGVyc2lzdGVudCBkYXRhIGRpcmVjdG9yeSAofi8uY2xhdWRlL3BsdWdpbnMvZGF0YS97aWR9LylcIixcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBwbHVnaW46IHN0cmluZyxcbiAgICAgICAgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY293b3JrPzogYm9vbGVhbjsga2VlcERhdGE/OiBib29sZWFuIH0sXG4gICAgICApID0+IHtcbiAgICAgICAgY29uc3QgeyBwbHVnaW5Vbmluc3RhbGxIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgcGx1Z2luVW5pbnN0YWxsSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gZW5hYmxlIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ2VuYWJsZSA8cGx1Z2luPicpXG4gICAgLmRlc2NyaXB0aW9uKCdFbmFibGUgYSBkaXNhYmxlZCBwbHVnaW4nKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICBgSW5zdGFsbGF0aW9uIHNjb3BlOiAke1ZBTElEX0lOU1RBTExBQkxFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogYXV0by1kZXRlY3QpYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKHBsdWdpbjogc3RyaW5nLCBvcHRpb25zOiB7IHNjb3BlPzogc3RyaW5nOyBjb3dvcms/OiBib29sZWFuIH0pID0+IHtcbiAgICAgICAgY29uc3QgeyBwbHVnaW5FbmFibGVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgJy4vY2xpL2hhbmRsZXJzL3BsdWdpbnMuanMnXG4gICAgICAgIClcbiAgICAgICAgYXdhaXQgcGx1Z2luRW5hYmxlSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gZGlzYWJsZSBjb21tYW5kXG4gIHBsdWdpbkNtZFxuICAgIC5jb21tYW5kKCdkaXNhYmxlIFtwbHVnaW5dJylcbiAgICAuZGVzY3JpcHRpb24oJ0Rpc2FibGUgYW4gZW5hYmxlZCBwbHVnaW4nKVxuICAgIC5vcHRpb24oJy1hLCAtLWFsbCcsICdEaXNhYmxlIGFsbCBlbmFibGVkIHBsdWdpbnMnKVxuICAgIC5vcHRpb24oXG4gICAgICAnLXMsIC0tc2NvcGUgPHNjb3BlPicsXG4gICAgICBgSW5zdGFsbGF0aW9uIHNjb3BlOiAke1ZBTElEX0lOU1RBTExBQkxFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogYXV0by1kZXRlY3QpYCxcbiAgICApXG4gICAgLmFkZE9wdGlvbihjb3dvcmtPcHRpb24oKSlcbiAgICAuYWN0aW9uKFxuICAgICAgYXN5bmMgKFxuICAgICAgICBwbHVnaW46IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICAgICAgb3B0aW9uczogeyBzY29wZT86IHN0cmluZzsgY293b3JrPzogYm9vbGVhbjsgYWxsPzogYm9vbGVhbiB9LFxuICAgICAgKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgcGx1Z2luRGlzYWJsZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgICAgKVxuICAgICAgICBhd2FpdCBwbHVnaW5EaXNhYmxlSGFuZGxlcihwbHVnaW4sIG9wdGlvbnMpXG4gICAgICB9LFxuICAgIClcblxuICAvLyBQbHVnaW4gdXBkYXRlIGNvbW1hbmRcbiAgcGx1Z2luQ21kXG4gICAgLmNvbW1hbmQoJ3VwZGF0ZSA8cGx1Z2luPicpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ1VwZGF0ZSBhIHBsdWdpbiB0byB0aGUgbGF0ZXN0IHZlcnNpb24gKHJlc3RhcnQgcmVxdWlyZWQgdG8gYXBwbHkpJyxcbiAgICApXG4gICAgLm9wdGlvbihcbiAgICAgICctcywgLS1zY29wZSA8c2NvcGU+JyxcbiAgICAgIGBJbnN0YWxsYXRpb24gc2NvcGU6ICR7VkFMSURfVVBEQVRFX1NDT1BFUy5qb2luKCcsICcpfSAoZGVmYXVsdDogdXNlcilgLFxuICAgIClcbiAgICAuYWRkT3B0aW9uKGNvd29ya09wdGlvbigpKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAocGx1Z2luOiBzdHJpbmcsIG9wdGlvbnM6IHsgc2NvcGU/OiBzdHJpbmc7IGNvd29yaz86IGJvb2xlYW4gfSkgPT4ge1xuICAgICAgICBjb25zdCB7IHBsdWdpblVwZGF0ZUhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydChcbiAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvcGx1Z2lucy5qcydcbiAgICAgICAgKVxuICAgICAgICBhd2FpdCBwbHVnaW5VcGRhdGVIYW5kbGVyKHBsdWdpbiwgb3B0aW9ucylcbiAgICAgIH0sXG4gICAgKVxuICAvLyBFTkQgQU5ULU9OTFlcblxuICAvLyBTZXR1cCB0b2tlbiBjb21tYW5kXG4gIHByb2dyYW1cbiAgICAuY29tbWFuZCgnc2V0dXAtdG9rZW4nKVxuICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICdTZXQgdXAgYSBsb25nLWxpdmVkIGF1dGhlbnRpY2F0aW9uIHRva2VuIChyZXF1aXJlcyBDbGF1ZGUgc3Vic2NyaXB0aW9uKScsXG4gICAgKVxuICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgY29uc3QgW3sgc2V0dXBUb2tlbkhhbmRsZXIgfSwgeyBjcmVhdGVSb290IH1dID0gYXdhaXQgUHJvbWlzZS5hbGwoW1xuICAgICAgICBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL3V0aWwuanMnKSxcbiAgICAgICAgaW1wb3J0KCcuL2luay5qcycpLFxuICAgICAgXSlcbiAgICAgIGNvbnN0IHJvb3QgPSBhd2FpdCBjcmVhdGVSb290KGdldEJhc2VSZW5kZXJPcHRpb25zKGZhbHNlKSlcbiAgICAgIGF3YWl0IHNldHVwVG9rZW5IYW5kbGVyKHJvb3QpXG4gICAgfSlcblxuICAvLyBBZ2VudHMgY29tbWFuZCAtIGxpc3QgY29uZmlndXJlZCBhZ2VudHNcbiAgcHJvZ3JhbVxuICAgIC5jb21tYW5kKCdhZ2VudHMnKVxuICAgIC5kZXNjcmlwdGlvbignTGlzdCBjb25maWd1cmVkIGFnZW50cycpXG4gICAgLm9wdGlvbihcbiAgICAgICctLXNldHRpbmctc291cmNlcyA8c291cmNlcz4nLFxuICAgICAgJ0NvbW1hLXNlcGFyYXRlZCBsaXN0IG9mIHNldHRpbmcgc291cmNlcyB0byBsb2FkICh1c2VyLCBwcm9qZWN0LCBsb2NhbCkuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCB7IGFnZW50c0hhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYWdlbnRzLmpzJylcbiAgICAgIGF3YWl0IGFnZW50c0hhbmRsZXIoKVxuICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgfSlcblxuICBpZiAoZmVhdHVyZSgnVFJBTlNDUklQVF9DTEFTU0lGSUVSJykpIHtcbiAgICAvLyBTa2lwIHdoZW4gdGVuZ3VfYXV0b19tb2RlX2NvbmZpZy5lbmFibGVkID09PSAnZGlzYWJsZWQnIChjaXJjdWl0IGJyZWFrZXIpLlxuICAgIC8vIFJlYWRzIGZyb20gZGlzayBjYWNoZSBcdTIwMTQgR3Jvd3RoQm9vayBpc24ndCBpbml0aWFsaXplZCBhdCByZWdpc3RyYXRpb24gdGltZS5cbiAgICBpZiAoZ2V0QXV0b01vZGVFbmFibGVkU3RhdGVJZkNhY2hlZCgpICE9PSAnZGlzYWJsZWQnKSB7XG4gICAgICBjb25zdCBhdXRvTW9kZUNtZCA9IHByb2dyYW1cbiAgICAgICAgLmNvbW1hbmQoJ2F1dG8tbW9kZScpXG4gICAgICAgIC5kZXNjcmlwdGlvbignSW5zcGVjdCBhdXRvIG1vZGUgY2xhc3NpZmllciBjb25maWd1cmF0aW9uJylcblxuICAgICAgYXV0b01vZGVDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2RlZmF1bHRzJylcbiAgICAgICAgLmRlc2NyaXB0aW9uKFxuICAgICAgICAgICdQcmludCB0aGUgZGVmYXVsdCBhdXRvIG1vZGUgZW52aXJvbm1lbnQsIGFsbG93LCBhbmQgZGVueSBydWxlcyBhcyBKU09OJyxcbiAgICAgICAgKVxuICAgICAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgICAgICBjb25zdCB7IGF1dG9Nb2RlRGVmYXVsdHNIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF1dG9Nb2RlRGVmYXVsdHNIYW5kbGVyKClcbiAgICAgICAgICBwcm9jZXNzLmV4aXQoMClcbiAgICAgICAgfSlcblxuICAgICAgYXV0b01vZGVDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2NvbmZpZycpXG4gICAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgICAnUHJpbnQgdGhlIGVmZmVjdGl2ZSBhdXRvIG1vZGUgY29uZmlnIGFzIEpTT046IHlvdXIgc2V0dGluZ3Mgd2hlcmUgc2V0LCBkZWZhdWx0cyBvdGhlcndpc2UnLFxuICAgICAgICApXG4gICAgICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgYXV0b01vZGVDb25maWdIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF1dG9Nb2RlQ29uZmlnSGFuZGxlcigpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KDApXG4gICAgICAgIH0pXG5cbiAgICAgIGF1dG9Nb2RlQ21kXG4gICAgICAgIC5jb21tYW5kKCdjcml0aXF1ZScpXG4gICAgICAgIC5kZXNjcmlwdGlvbignR2V0IEFJIGZlZWRiYWNrIG9uIHlvdXIgY3VzdG9tIGF1dG8gbW9kZSBydWxlcycpXG4gICAgICAgIC5vcHRpb24oJy0tbW9kZWwgPG1vZGVsPicsICdPdmVycmlkZSB3aGljaCBtb2RlbCBpcyB1c2VkJylcbiAgICAgICAgLmFjdGlvbihhc3luYyBvcHRpb25zID0+IHtcbiAgICAgICAgICBjb25zdCB7IGF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoXG4gICAgICAgICAgICAnLi9jbGkvaGFuZGxlcnMvYXV0b01vZGUuanMnXG4gICAgICAgICAgKVxuICAgICAgICAgIGF3YWl0IGF1dG9Nb2RlQ3JpdGlxdWVIYW5kbGVyKG9wdGlvbnMpXG4gICAgICAgICAgcHJvY2Vzcy5leGl0KClcbiAgICAgICAgfSlcbiAgICB9XG4gIH1cblxuICAvLyBSZW1vdGUgQ29udHJvbCBjb21tYW5kIFx1MjAxNCBjb25uZWN0IGxvY2FsIGVudmlyb25tZW50IHRvIGNsYXVkZS5haS9jb2RlLlxuICAvLyBUaGUgYWN0dWFsIGNvbW1hbmQgaXMgaW50ZXJjZXB0ZWQgYnkgdGhlIGZhc3QtcGF0aCBpbiBjbGkudHN4IGJlZm9yZVxuICAvLyBDb21tYW5kZXIuanMgcnVucywgc28gdGhpcyByZWdpc3RyYXRpb24gZXhpc3RzIG9ubHkgZm9yIGhlbHAgb3V0cHV0LlxuICAvLyBBbHdheXMgaGlkZGVuOiBpc0JyaWRnZUVuYWJsZWQoKSBhdCB0aGlzIHBvaW50IChiZWZvcmUgZW5hYmxlQ29uZmlncylcbiAgLy8gd291bGQgdGhyb3cgaW5zaWRlIGlzQ2xhdWRlQUlTdWJzY3JpYmVyIFx1MjE5MiBnZXRHbG9iYWxDb25maWcgYW5kIHJldHVyblxuICAvLyBmYWxzZSB2aWEgdGhlIHRyeS9jYXRjaCBcdTIwMTQgYnV0IG5vdCBiZWZvcmUgcGF5aW5nIH42NW1zIG9mIHNpZGUgZWZmZWN0c1xuICAvLyAoMjVtcyBzZXR0aW5ncyBab2QgcGFyc2UgKyA0MG1zIHN5bmMgYHNlY3VyaXR5YCBrZXljaGFpbiBzdWJwcm9jZXNzKS5cbiAgLy8gVGhlIGR5bmFtaWMgdmlzaWJpbGl0eSBuZXZlciB3b3JrZWQ7IHRoZSBjb21tYW5kIHdhcyBhbHdheXMgaGlkZGVuLlxuICBpZiAoZmVhdHVyZSgnQlJJREdFX01PREUnKSkge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdyZW1vdGUtY29udHJvbCcsIHsgaGlkZGVuOiB0cnVlIH0pXG4gICAgICAuYWxpYXMoJ3JjJylcbiAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgJ0Nvbm5lY3QgeW91ciBsb2NhbCBlbnZpcm9ubWVudCBmb3IgcmVtb3RlLWNvbnRyb2wgc2Vzc2lvbnMgdmlhIGNsYXVkZS5haS9jb2RlJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oYXN5bmMgKCkgPT4ge1xuICAgICAgICAvLyBVbnJlYWNoYWJsZSBcdTIwMTQgY2xpLnRzeCBmYXN0LXBhdGggaGFuZGxlcyB0aGlzIGNvbW1hbmQgYmVmb3JlIG1haW4udHN4IGxvYWRzLlxuICAgICAgICAvLyBJZiBzb21laG93IHJlYWNoZWQsIGRlbGVnYXRlIHRvIGJyaWRnZU1haW4uXG4gICAgICAgIGNvbnN0IHsgYnJpZGdlTWFpbiB9ID0gYXdhaXQgaW1wb3J0KCcuL2JyaWRnZS9icmlkZ2VNYWluLmpzJylcbiAgICAgICAgYXdhaXQgYnJpZGdlTWFpbihwcm9jZXNzLmFyZ3Yuc2xpY2UoMykpXG4gICAgICB9KVxuICB9XG5cbiAgaWYgKGZlYXR1cmUoJ0tBSVJPUycpKSB7XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ2Fzc2lzdGFudCBbc2Vzc2lvbklkXScpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdBdHRhY2ggdGhlIFJFUEwgYXMgYSBjbGllbnQgdG8gYSBydW5uaW5nIGJyaWRnZSBzZXNzaW9uLiBEaXNjb3ZlcnMgc2Vzc2lvbnMgdmlhIEFQSSBpZiBubyBzZXNzaW9uSWQgZ2l2ZW4uJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oKCkgPT4ge1xuICAgICAgICAvLyBBcmd2IHJld3JpdGluZyBhYm92ZSBzaG91bGQgaGF2ZSBjb25zdW1lZCBgYXNzaXN0YW50IFtpZF1gXG4gICAgICAgIC8vIGJlZm9yZSBjb21tYW5kZXIgcnVucy4gUmVhY2hpbmcgaGVyZSBtZWFucyBhIHJvb3QgZmxhZyBjYW1lIGZpcnN0XG4gICAgICAgIC8vIChlLmcuIGAtLWRlYnVnIGFzc2lzdGFudGApIGFuZCB0aGUgcG9zaXRpb24tMCBwcmVkaWNhdGVcbiAgICAgICAgLy8gZGlkbid0IG1hdGNoLiBQcmludCB1c2FnZSBsaWtlIHRoZSBzc2ggc3R1YiBkb2VzLlxuICAgICAgICBwcm9jZXNzLnN0ZGVyci53cml0ZShcbiAgICAgICAgICAnVXNhZ2U6IGNsYXVkZSBhc3Npc3RhbnQgW3Nlc3Npb25JZF1cXG5cXG4nICtcbiAgICAgICAgICAgICdBdHRhY2ggdGhlIFJFUEwgYXMgYSB2aWV3ZXIgY2xpZW50IHRvIGEgcnVubmluZyBicmlkZ2Ugc2Vzc2lvbi5cXG4nICtcbiAgICAgICAgICAgICdPbWl0IHNlc3Npb25JZCB0byBkaXNjb3ZlciBhbmQgcGljayBmcm9tIGF2YWlsYWJsZSBzZXNzaW9ucy5cXG4nLFxuICAgICAgICApXG4gICAgICAgIHByb2Nlc3MuZXhpdCgxKVxuICAgICAgfSlcbiAgfVxuXG4gIC8vIERvY3RvciBjb21tYW5kIC0gY2hlY2sgaW5zdGFsbGF0aW9uIGhlYWx0aFxuICBwcm9ncmFtXG4gICAgLmNvbW1hbmQoJ2RvY3RvcicpXG4gICAgLmRlc2NyaXB0aW9uKFxuICAgICAgJ0NoZWNrIHRoZSBoZWFsdGggb2YgeW91ciBDbGF1ZGUgQ29kZSBhdXRvLXVwZGF0ZXIuIE5vdGU6IFRoZSB3b3Jrc3BhY2UgdHJ1c3QgZGlhbG9nIGlzIHNraXBwZWQgYW5kIHN0ZGlvIHNlcnZlcnMgZnJvbSAubWNwLmpzb24gYXJlIHNwYXduZWQgZm9yIGhlYWx0aCBjaGVja3MuIE9ubHkgdXNlIHRoaXMgY29tbWFuZCBpbiBkaXJlY3RvcmllcyB5b3UgdHJ1c3QuJyxcbiAgICApXG4gICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICBjb25zdCBbeyBkb2N0b3JIYW5kbGVyIH0sIHsgY3JlYXRlUm9vdCB9XSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgICAgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy91dGlsLmpzJyksXG4gICAgICAgIGltcG9ydCgnLi9pbmsuanMnKSxcbiAgICAgIF0pXG4gICAgICBjb25zdCByb290ID0gYXdhaXQgY3JlYXRlUm9vdChnZXRCYXNlUmVuZGVyT3B0aW9ucyhmYWxzZSkpXG4gICAgICBhd2FpdCBkb2N0b3JIYW5kbGVyKHJvb3QpXG4gICAgfSlcblxuICAvLyBjbGF1ZGUgdXBkYXRlXG4gIC8vXG4gIC8vIEZvciBTZW1WZXItY29tcGxpYW50IHZlcnNpb25pbmcgd2l0aCBidWlsZCBtZXRhZGF0YSAoWC5YLlgrU0hBKTpcbiAgLy8gLSBXZSBwZXJmb3JtIGV4YWN0IHN0cmluZyBjb21wYXJpc29uIChpbmNsdWRpbmcgU0hBKSB0byBkZXRlY3QgYW55IGNoYW5nZVxuICAvLyAtIFRoaXMgZW5zdXJlcyB1c2VycyBhbHdheXMgZ2V0IHRoZSBsYXRlc3QgYnVpbGQsIGV2ZW4gd2hlbiBvbmx5IHRoZSBTSEEgY2hhbmdlc1xuICAvLyAtIFVJIHNob3dzIGJvdGggdmVyc2lvbnMgaW5jbHVkaW5nIGJ1aWxkIG1ldGFkYXRhIGZvciBjbGFyaXR5XG4gIHByb2dyYW1cbiAgICAuY29tbWFuZCgndXBkYXRlJylcbiAgICAuYWxpYXMoJ3VwZ3JhZGUnKVxuICAgIC5kZXNjcmlwdGlvbignQ2hlY2sgZm9yIHVwZGF0ZXMgYW5kIGluc3RhbGwgaWYgYXZhaWxhYmxlJylcbiAgICAuYWN0aW9uKGFzeW5jICgpID0+IHtcbiAgICAgIGNvbnN0IHsgdXBkYXRlIH0gPSBhd2FpdCBpbXBvcnQoJ3NyYy9jbGkvdXBkYXRlLmpzJylcbiAgICAgIGF3YWl0IHVwZGF0ZSgpXG4gICAgfSlcblxuICAvLyBjbGF1ZGUgdXAgXHUyMDE0IHJ1biB0aGUgcHJvamVjdCdzIENMQVVERS5tZCBcIiMgY2xhdWRlIHVwXCIgc2V0dXAgaW5zdHJ1Y3Rpb25zLlxuICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCd1cCcpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdbQU5ULU9OTFldIEluaXRpYWxpemUgb3IgdXBncmFkZSB0aGUgbG9jYWwgZGV2IGVudmlyb25tZW50IHVzaW5nIHRoZSBcIiMgY2xhdWRlIHVwXCIgc2VjdGlvbiBvZiB0aGUgbmVhcmVzdCBDTEFVREUubWQnLFxuICAgICAgKVxuICAgICAgLmFjdGlvbihhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgdXAgfSA9IGF3YWl0IGltcG9ydCgnc3JjL2NsaS91cC5qcycpXG4gICAgICAgIGF3YWl0IHVwKClcbiAgICAgIH0pXG4gIH1cblxuICAvLyBjbGF1ZGUgcm9sbGJhY2sgKGFudC1vbmx5KVxuICAvLyBSb2xscyBiYWNrIHRvIHByZXZpb3VzIHJlbGVhc2VzXG4gIGlmIChcImV4dGVybmFsXCIgPT09ICdhbnQnKSB7XG4gICAgcHJvZ3JhbVxuICAgICAgLmNvbW1hbmQoJ3JvbGxiYWNrIFt0YXJnZXRdJylcbiAgICAgIC5kZXNjcmlwdGlvbihcbiAgICAgICAgJ1tBTlQtT05MWV0gUm9sbCBiYWNrIHRvIGEgcHJldmlvdXMgcmVsZWFzZVxcblxcbkV4YW1wbGVzOlxcbiAgY2xhdWRlIHJvbGxiYWNrICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgR28gMSB2ZXJzaW9uIGJhY2sgZnJvbSBjdXJyZW50XFxuICBjbGF1ZGUgcm9sbGJhY2sgMyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBHbyAzIHZlcnNpb25zIGJhY2sgZnJvbSBjdXJyZW50XFxuICBjbGF1ZGUgcm9sbGJhY2sgMi4wLjczLWRldi4yMDI1MTIxNy50MTkwNjU4ICAgICAgICBSb2xsIGJhY2sgdG8gYSBzcGVjaWZpYyB2ZXJzaW9uJyxcbiAgICAgIClcbiAgICAgIC5vcHRpb24oJy1sLCAtLWxpc3QnLCAnTGlzdCByZWNlbnQgcHVibGlzaGVkIHZlcnNpb25zIHdpdGggYWdlcycpXG4gICAgICAub3B0aW9uKCctLWRyeS1ydW4nLCAnU2hvdyB3aGF0IHdvdWxkIGJlIGluc3RhbGxlZCB3aXRob3V0IGluc3RhbGxpbmcnKVxuICAgICAgLm9wdGlvbihcbiAgICAgICAgJy0tc2FmZScsXG4gICAgICAgICdSb2xsIGJhY2sgdG8gdGhlIHNlcnZlci1waW5uZWQgc2FmZSB2ZXJzaW9uIChzZXQgYnkgb25jYWxsIGR1cmluZyBpbmNpZGVudHMpJyxcbiAgICAgIClcbiAgICAgIC5hY3Rpb24oXG4gICAgICAgIGFzeW5jIChcbiAgICAgICAgICB0YXJnZXQ/OiBzdHJpbmcsXG4gICAgICAgICAgb3B0aW9ucz86IHsgbGlzdD86IGJvb2xlYW47IGRyeVJ1bj86IGJvb2xlYW47IHNhZmU/OiBib29sZWFuIH0sXG4gICAgICAgICkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgcm9sbGJhY2sgfSA9IGF3YWl0IGltcG9ydCgnc3JjL2NsaS9yb2xsYmFjay5qcycpXG4gICAgICAgICAgYXdhaXQgcm9sbGJhY2sodGFyZ2V0LCBvcHRpb25zKVxuICAgICAgICB9LFxuICAgICAgKVxuICB9XG5cbiAgLy8gY2xhdWRlIGluc3RhbGxcbiAgcHJvZ3JhbVxuICAgIC5jb21tYW5kKCdpbnN0YWxsIFt0YXJnZXRdJylcbiAgICAuZGVzY3JpcHRpb24oXG4gICAgICAnSW5zdGFsbCBDbGF1ZGUgQ29kZSBuYXRpdmUgYnVpbGQuIFVzZSBbdGFyZ2V0XSB0byBzcGVjaWZ5IHZlcnNpb24gKHN0YWJsZSwgbGF0ZXN0LCBvciBzcGVjaWZpYyB2ZXJzaW9uKScsXG4gICAgKVxuICAgIC5vcHRpb24oJy0tZm9yY2UnLCAnRm9yY2UgaW5zdGFsbGF0aW9uIGV2ZW4gaWYgYWxyZWFkeSBpbnN0YWxsZWQnKVxuICAgIC5hY3Rpb24oXG4gICAgICBhc3luYyAodGFyZ2V0OiBzdHJpbmcgfCB1bmRlZmluZWQsIG9wdGlvbnM6IHsgZm9yY2U/OiBib29sZWFuIH0pID0+IHtcbiAgICAgICAgY29uc3QgeyBpbnN0YWxsSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy91dGlsLmpzJylcbiAgICAgICAgYXdhaXQgaW5zdGFsbEhhbmRsZXIodGFyZ2V0LCBvcHRpb25zKVxuICAgICAgfSxcbiAgICApXG5cbiAgLy8gYW50LW9ubHkgY29tbWFuZHNcbiAgaWYgKFwiZXh0ZXJuYWxcIiA9PT0gJ2FudCcpIHtcbiAgICBjb25zdCB2YWxpZGF0ZUxvZ0lkID0gKHZhbHVlOiBzdHJpbmcpID0+IHtcbiAgICAgIGNvbnN0IG1heWJlU2Vzc2lvbklkID0gdmFsaWRhdGVVdWlkKHZhbHVlKVxuICAgICAgaWYgKG1heWJlU2Vzc2lvbklkKSByZXR1cm4gbWF5YmVTZXNzaW9uSWRcbiAgICAgIHJldHVybiBOdW1iZXIodmFsdWUpXG4gICAgfVxuICAgIC8vIGNsYXVkZSBsb2dcbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnbG9nJylcbiAgICAgIC5kZXNjcmlwdGlvbignW0FOVC1PTkxZXSBNYW5hZ2UgY29udmVyc2F0aW9uIGxvZ3MuJylcbiAgICAgIC5hcmd1bWVudChcbiAgICAgICAgJ1tudW1iZXJ8c2Vzc2lvbklkXScsXG4gICAgICAgICdBIG51bWJlciAoMCwgMSwgMiwgZXRjLikgdG8gZGlzcGxheSBhIHNwZWNpZmljIGxvZywgb3IgdGhlIHNlc3NzaW9uIElEICh1dWlkKSBvZiBhIGxvZycsXG4gICAgICAgIHZhbGlkYXRlTG9nSWQsXG4gICAgICApXG4gICAgICAuYWN0aW9uKGFzeW5jIChsb2dJZDogc3RyaW5nIHwgbnVtYmVyIHwgdW5kZWZpbmVkKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgbG9nSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICBhd2FpdCBsb2dIYW5kbGVyKGxvZ0lkKVxuICAgICAgfSlcblxuICAgIC8vIGNsYXVkZSBlcnJvclxuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdlcnJvcicpXG4gICAgICAuZGVzY3JpcHRpb24oXG4gICAgICAgICdbQU5ULU9OTFldIFZpZXcgZXJyb3IgbG9ncy4gT3B0aW9uYWxseSBwcm92aWRlIGEgbnVtYmVyICgwLCAtMSwgLTIsIGV0Yy4pIHRvIGRpc3BsYXkgYSBzcGVjaWZpYyBsb2cuJyxcbiAgICAgIClcbiAgICAgIC5hcmd1bWVudChcbiAgICAgICAgJ1tudW1iZXJdJyxcbiAgICAgICAgJ0EgbnVtYmVyICgwLCAxLCAyLCBldGMuKSB0byBkaXNwbGF5IGEgc3BlY2lmaWMgbG9nJyxcbiAgICAgICAgcGFyc2VJbnQsXG4gICAgICApXG4gICAgICAuYWN0aW9uKGFzeW5jIChudW1iZXI6IG51bWJlciB8IHVuZGVmaW5lZCkgPT4ge1xuICAgICAgICBjb25zdCB7IGVycm9ySGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICBhd2FpdCBlcnJvckhhbmRsZXIobnVtYmVyKVxuICAgICAgfSlcblxuICAgIC8vIGNsYXVkZSBleHBvcnRcbiAgICBwcm9ncmFtXG4gICAgICAuY29tbWFuZCgnZXhwb3J0JylcbiAgICAgIC5kZXNjcmlwdGlvbignW0FOVC1PTkxZXSBFeHBvcnQgYSBjb252ZXJzYXRpb24gdG8gYSB0ZXh0IGZpbGUuJylcbiAgICAgIC51c2FnZSgnPHNvdXJjZT4gPG91dHB1dEZpbGU+JylcbiAgICAgIC5hcmd1bWVudChcbiAgICAgICAgJzxzb3VyY2U+JyxcbiAgICAgICAgJ1Nlc3Npb24gSUQsIGxvZyBpbmRleCAoMCwgMSwgMi4uLiksIG9yIHBhdGggdG8gYSAuanNvbi8uanNvbmwgbG9nIGZpbGUnLFxuICAgICAgKVxuICAgICAgLmFyZ3VtZW50KCc8b3V0cHV0RmlsZT4nLCAnT3V0cHV0IGZpbGUgcGF0aCBmb3IgdGhlIGV4cG9ydGVkIHRleHQnKVxuICAgICAgLmFkZEhlbHBUZXh0KFxuICAgICAgICAnYWZ0ZXInLFxuICAgICAgICBgXG5FeGFtcGxlczpcbiAgJCBjbGF1ZGUgZXhwb3J0IDAgY29udmVyc2F0aW9uLnR4dCAgICAgICAgICAgICAgICBFeHBvcnQgY29udmVyc2F0aW9uIGF0IGxvZyBpbmRleCAwXG4gICQgY2xhdWRlIGV4cG9ydCA8dXVpZD4gY29udmVyc2F0aW9uLnR4dCAgICAgICAgICAgRXhwb3J0IGNvbnZlcnNhdGlvbiBieSBzZXNzaW9uIElEXG4gICQgY2xhdWRlIGV4cG9ydCBpbnB1dC5qc29uIG91dHB1dC50eHQgICAgICAgICAgICAgUmVuZGVyIEpTT04gbG9nIGZpbGUgdG8gdGV4dFxuICAkIGNsYXVkZSBleHBvcnQgPHV1aWQ+Lmpzb25sIG91dHB1dC50eHQgICAgICAgICAgIFJlbmRlciBKU09OTCBzZXNzaW9uIGZpbGUgdG8gdGV4dGAsXG4gICAgICApXG4gICAgICAuYWN0aW9uKGFzeW5jIChzb3VyY2U6IHN0cmluZywgb3V0cHV0RmlsZTogc3RyaW5nKSA9PiB7XG4gICAgICAgIGNvbnN0IHsgZXhwb3J0SGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICBhd2FpdCBleHBvcnRIYW5kbGVyKHNvdXJjZSwgb3V0cHV0RmlsZSlcbiAgICAgIH0pXG5cbiAgICBpZiAoXCJleHRlcm5hbFwiID09PSAnYW50Jykge1xuICAgICAgY29uc3QgdGFza0NtZCA9IHByb2dyYW1cbiAgICAgICAgLmNvbW1hbmQoJ3Rhc2snKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ1tBTlQtT05MWV0gTWFuYWdlIHRhc2sgbGlzdCB0YXNrcycpXG5cbiAgICAgIHRhc2tDbWRcbiAgICAgICAgLmNvbW1hbmQoJ2NyZWF0ZSA8c3ViamVjdD4nKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ0NyZWF0ZSBhIG5ldyB0YXNrJylcbiAgICAgICAgLm9wdGlvbignLWQsIC0tZGVzY3JpcHRpb24gPHRleHQ+JywgJ1Rhc2sgZGVzY3JpcHRpb24nKVxuICAgICAgICAub3B0aW9uKCctbCwgLS1saXN0IDxpZD4nLCAnVGFzayBsaXN0IElEIChkZWZhdWx0cyB0byBcInRhc2tsaXN0XCIpJylcbiAgICAgICAgLmFjdGlvbihcbiAgICAgICAgICBhc3luYyAoXG4gICAgICAgICAgICBzdWJqZWN0OiBzdHJpbmcsXG4gICAgICAgICAgICBvcHRzOiB7IGRlc2NyaXB0aW9uPzogc3RyaW5nOyBsaXN0Pzogc3RyaW5nIH0sXG4gICAgICAgICAgKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB7IHRhc2tDcmVhdGVIYW5kbGVyIH0gPSBhd2FpdCBpbXBvcnQoJy4vY2xpL2hhbmRsZXJzL2FudC5qcycpXG4gICAgICAgICAgICBhd2FpdCB0YXNrQ3JlYXRlSGFuZGxlcihzdWJqZWN0LCBvcHRzKVxuICAgICAgICAgIH0sXG4gICAgICAgIClcblxuICAgICAgdGFza0NtZFxuICAgICAgICAuY29tbWFuZCgnbGlzdCcpXG4gICAgICAgIC5kZXNjcmlwdGlvbignTGlzdCBhbGwgdGFza3MnKVxuICAgICAgICAub3B0aW9uKCctbCwgLS1saXN0IDxpZD4nLCAnVGFzayBsaXN0IElEIChkZWZhdWx0cyB0byBcInRhc2tsaXN0XCIpJylcbiAgICAgICAgLm9wdGlvbignLS1wZW5kaW5nJywgJ1Nob3cgb25seSBwZW5kaW5nIHRhc2tzJylcbiAgICAgICAgLm9wdGlvbignLS1qc29uJywgJ091dHB1dCBhcyBKU09OJylcbiAgICAgICAgLmFjdGlvbihcbiAgICAgICAgICBhc3luYyAob3B0czoge1xuICAgICAgICAgICAgbGlzdD86IHN0cmluZ1xuICAgICAgICAgICAgcGVuZGluZz86IGJvb2xlYW5cbiAgICAgICAgICAgIGpzb24/OiBib29sZWFuXG4gICAgICAgICAgfSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgeyB0YXNrTGlzdEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgICAgIGF3YWl0IHRhc2tMaXN0SGFuZGxlcihvcHRzKVxuICAgICAgICAgIH0sXG4gICAgICAgIClcblxuICAgICAgdGFza0NtZFxuICAgICAgICAuY29tbWFuZCgnZ2V0IDxpZD4nKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ0dldCBkZXRhaWxzIG9mIGEgdGFzaycpXG4gICAgICAgIC5vcHRpb24oJy1sLCAtLWxpc3QgPGlkPicsICdUYXNrIGxpc3QgSUQgKGRlZmF1bHRzIHRvIFwidGFza2xpc3RcIiknKVxuICAgICAgICAuYWN0aW9uKGFzeW5jIChpZDogc3RyaW5nLCBvcHRzOiB7IGxpc3Q/OiBzdHJpbmcgfSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHsgdGFza0dldEhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgICBhd2FpdCB0YXNrR2V0SGFuZGxlcihpZCwgb3B0cylcbiAgICAgICAgfSlcblxuICAgICAgdGFza0NtZFxuICAgICAgICAuY29tbWFuZCgndXBkYXRlIDxpZD4nKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ1VwZGF0ZSBhIHRhc2snKVxuICAgICAgICAub3B0aW9uKCctbCwgLS1saXN0IDxpZD4nLCAnVGFzayBsaXN0IElEIChkZWZhdWx0cyB0byBcInRhc2tsaXN0XCIpJylcbiAgICAgICAgLm9wdGlvbihcbiAgICAgICAgICAnLXMsIC0tc3RhdHVzIDxzdGF0dXM+JyxcbiAgICAgICAgICBgU2V0IHN0YXR1cyAoJHtUQVNLX1NUQVRVU0VTLmpvaW4oJywgJyl9KWAsXG4gICAgICAgIClcbiAgICAgICAgLm9wdGlvbignLS1zdWJqZWN0IDx0ZXh0PicsICdVcGRhdGUgc3ViamVjdCcpXG4gICAgICAgIC5vcHRpb24oJy1kLCAtLWRlc2NyaXB0aW9uIDx0ZXh0PicsICdVcGRhdGUgZGVzY3JpcHRpb24nKVxuICAgICAgICAub3B0aW9uKCctLW93bmVyIDxhZ2VudElkPicsICdTZXQgb3duZXInKVxuICAgICAgICAub3B0aW9uKCctLWNsZWFyLW93bmVyJywgJ0NsZWFyIG93bmVyJylcbiAgICAgICAgLmFjdGlvbihcbiAgICAgICAgICBhc3luYyAoXG4gICAgICAgICAgICBpZDogc3RyaW5nLFxuICAgICAgICAgICAgb3B0czoge1xuICAgICAgICAgICAgICBsaXN0Pzogc3RyaW5nXG4gICAgICAgICAgICAgIHN0YXR1cz86IHN0cmluZ1xuICAgICAgICAgICAgICBzdWJqZWN0Pzogc3RyaW5nXG4gICAgICAgICAgICAgIGRlc2NyaXB0aW9uPzogc3RyaW5nXG4gICAgICAgICAgICAgIG93bmVyPzogc3RyaW5nXG4gICAgICAgICAgICAgIGNsZWFyT3duZXI/OiBib29sZWFuXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICkgPT4ge1xuICAgICAgICAgICAgY29uc3QgeyB0YXNrVXBkYXRlSGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICAgICAgYXdhaXQgdGFza1VwZGF0ZUhhbmRsZXIoaWQsIG9wdHMpXG4gICAgICAgICAgfSxcbiAgICAgICAgKVxuXG4gICAgICB0YXNrQ21kXG4gICAgICAgIC5jb21tYW5kKCdkaXInKVxuICAgICAgICAuZGVzY3JpcHRpb24oJ1Nob3cgdGhlIHRhc2tzIGRpcmVjdG9yeSBwYXRoJylcbiAgICAgICAgLm9wdGlvbignLWwsIC0tbGlzdCA8aWQ+JywgJ1Rhc2sgbGlzdCBJRCAoZGVmYXVsdHMgdG8gXCJ0YXNrbGlzdFwiKScpXG4gICAgICAgIC5hY3Rpb24oYXN5bmMgKG9wdHM6IHsgbGlzdD86IHN0cmluZyB9KSA9PiB7XG4gICAgICAgICAgY29uc3QgeyB0YXNrRGlySGFuZGxlciB9ID0gYXdhaXQgaW1wb3J0KCcuL2NsaS9oYW5kbGVycy9hbnQuanMnKVxuICAgICAgICAgIGF3YWl0IHRhc2tEaXJIYW5kbGVyKG9wdHMpXG4gICAgICAgIH0pXG4gICAgfVxuXG4gICAgLy8gY2xhdWRlIGNvbXBsZXRpb24gPHNoZWxsPlxuICAgIHByb2dyYW1cbiAgICAgIC5jb21tYW5kKCdjb21wbGV0aW9uIDxzaGVsbD4nLCB7IGhpZGRlbjogdHJ1ZSB9KVxuICAgICAgLmRlc2NyaXB0aW9uKCdHZW5lcmF0ZSBzaGVsbCBjb21wbGV0aW9uIHNjcmlwdCAoYmFzaCwgenNoLCBvciBmaXNoKScpXG4gICAgICAub3B0aW9uKFxuICAgICAgICAnLS1vdXRwdXQgPGZpbGU+JyxcbiAgICAgICAgJ1dyaXRlIGNvbXBsZXRpb24gc2NyaXB0IGRpcmVjdGx5IHRvIGEgZmlsZSBpbnN0ZWFkIG9mIHN0ZG91dCcsXG4gICAgICApXG4gICAgICAuYWN0aW9uKGFzeW5jIChzaGVsbDogc3RyaW5nLCBvcHRzOiB7IG91dHB1dD86IHN0cmluZyB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHsgY29tcGxldGlvbkhhbmRsZXIgfSA9IGF3YWl0IGltcG9ydCgnLi9jbGkvaGFuZGxlcnMvYW50LmpzJylcbiAgICAgICAgYXdhaXQgY29tcGxldGlvbkhhbmRsZXIoc2hlbGwsIG9wdHMsIHByb2dyYW0pXG4gICAgICB9KVxuICB9XG5cbiAgcHJvZmlsZUNoZWNrcG9pbnQoJ3J1bl9iZWZvcmVfcGFyc2UnKVxuICBhd2FpdCBwcm9ncmFtLnBhcnNlQXN5bmMocHJvY2Vzcy5hcmd2KVxuICBwcm9maWxlQ2hlY2twb2ludCgncnVuX2FmdGVyX3BhcnNlJylcblxuICAvLyBSZWNvcmQgZmluYWwgY2hlY2twb2ludCBmb3IgdG90YWxfdGltZSBjYWxjdWxhdGlvblxuICBwcm9maWxlQ2hlY2twb2ludCgnbWFpbl9hZnRlcl9ydW4nKVxuXG4gIC8vIExvZyBzdGFydHVwIHBlcmYgdG8gU3RhdHNpZyAoc2FtcGxlZCkgYW5kIG91dHB1dCBkZXRhaWxlZCByZXBvcnQgaWYgZW5hYmxlZFxuICBwcm9maWxlUmVwb3J0KClcblxuICByZXR1cm4gcHJvZ3JhbVxufVxuXG5hc3luYyBmdW5jdGlvbiBsb2dUZW5ndUluaXQoe1xuICBoYXNJbml0aWFsUHJvbXB0LFxuICBoYXNTdGRpbixcbiAgdmVyYm9zZSxcbiAgZGVidWcsXG4gIGRlYnVnVG9TdGRlcnIsXG4gIHByaW50LFxuICBvdXRwdXRGb3JtYXQsXG4gIGlucHV0Rm9ybWF0LFxuICBudW1BbGxvd2VkVG9vbHMsXG4gIG51bURpc2FsbG93ZWRUb29scyxcbiAgbWNwQ2xpZW50Q291bnQsXG4gIHdvcmt0cmVlRW5hYmxlZCxcbiAgc2tpcFdlYkZldGNoUHJlZmxpZ2h0LFxuICBnaXRodWJBY3Rpb25JbnB1dHMsXG4gIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkLFxuICBwZXJtaXNzaW9uTW9kZSxcbiAgbW9kZUlzQnlwYXNzLFxuICBhbGxvd0Rhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkLFxuICBzeXN0ZW1Qcm9tcHRGbGFnLFxuICBhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnLFxuICB0aGlua2luZ0NvbmZpZyxcbiAgYXNzaXN0YW50QWN0aXZhdGlvblBhdGgsXG59OiB7XG4gIGhhc0luaXRpYWxQcm9tcHQ6IGJvb2xlYW5cbiAgaGFzU3RkaW46IGJvb2xlYW5cbiAgdmVyYm9zZTogYm9vbGVhblxuICBkZWJ1ZzogYm9vbGVhblxuICBkZWJ1Z1RvU3RkZXJyOiBib29sZWFuXG4gIHByaW50OiBib29sZWFuXG4gIG91dHB1dEZvcm1hdDogc3RyaW5nXG4gIGlucHV0Rm9ybWF0OiBzdHJpbmdcbiAgbnVtQWxsb3dlZFRvb2xzOiBudW1iZXJcbiAgbnVtRGlzYWxsb3dlZFRvb2xzOiBudW1iZXJcbiAgbWNwQ2xpZW50Q291bnQ6IG51bWJlclxuICB3b3JrdHJlZUVuYWJsZWQ6IGJvb2xlYW5cbiAgc2tpcFdlYkZldGNoUHJlZmxpZ2h0OiBib29sZWFuIHwgdW5kZWZpbmVkXG4gIGdpdGh1YkFjdGlvbklucHV0czogc3RyaW5nIHwgdW5kZWZpbmVkXG4gIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkOiBib29sZWFuXG4gIHBlcm1pc3Npb25Nb2RlOiBzdHJpbmdcbiAgbW9kZUlzQnlwYXNzOiBib29sZWFuXG4gIGFsbG93RGFuZ2Vyb3VzbHlTa2lwUGVybWlzc2lvbnNQYXNzZWQ6IGJvb2xlYW5cbiAgc3lzdGVtUHJvbXB0RmxhZzogJ2ZpbGUnIHwgJ2ZsYWcnIHwgdW5kZWZpbmVkXG4gIGFwcGVuZFN5c3RlbVByb21wdEZsYWc6ICdmaWxlJyB8ICdmbGFnJyB8IHVuZGVmaW5lZFxuICB0aGlua2luZ0NvbmZpZzogVGhpbmtpbmdDb25maWdcbiAgYXNzaXN0YW50QWN0aXZhdGlvblBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZFxufSk6IFByb21pc2U8dm9pZD4ge1xuICB0cnkge1xuICAgIGxvZ0V2ZW50KCd0ZW5ndV9pbml0Jywge1xuICAgICAgZW50cnlwb2ludDpcbiAgICAgICAgJ2NsYXVkZScgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIGhhc0luaXRpYWxQcm9tcHQsXG4gICAgICBoYXNTdGRpbixcbiAgICAgIHZlcmJvc2UsXG4gICAgICBkZWJ1ZyxcbiAgICAgIGRlYnVnVG9TdGRlcnIsXG4gICAgICBwcmludCxcbiAgICAgIG91dHB1dEZvcm1hdDpcbiAgICAgICAgb3V0cHV0Rm9ybWF0IGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICBpbnB1dEZvcm1hdDpcbiAgICAgICAgaW5wdXRGb3JtYXQgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIG51bUFsbG93ZWRUb29scyxcbiAgICAgIG51bURpc2FsbG93ZWRUb29scyxcbiAgICAgIG1jcENsaWVudENvdW50LFxuICAgICAgd29ya3RyZWU6IHdvcmt0cmVlRW5hYmxlZCxcbiAgICAgIHNraXBXZWJGZXRjaFByZWZsaWdodCxcbiAgICAgIC4uLihnaXRodWJBY3Rpb25JbnB1dHMgJiYge1xuICAgICAgICBnaXRodWJBY3Rpb25JbnB1dHM6XG4gICAgICAgICAgZ2l0aHViQWN0aW9uSW5wdXRzIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KSxcbiAgICAgIGRhbmdlcm91c2x5U2tpcFBlcm1pc3Npb25zUGFzc2VkLFxuICAgICAgcGVybWlzc2lvbk1vZGU6XG4gICAgICAgIHBlcm1pc3Npb25Nb2RlIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICBtb2RlSXNCeXBhc3MsXG4gICAgICBpblByb3RlY3RlZE5hbWVzcGFjZTogaXNJblByb3RlY3RlZE5hbWVzcGFjZSgpLFxuICAgICAgYWxsb3dEYW5nZXJvdXNseVNraXBQZXJtaXNzaW9uc1Bhc3NlZCxcbiAgICAgIHRoaW5raW5nVHlwZTpcbiAgICAgICAgdGhpbmtpbmdDb25maWcudHlwZSBhcyBBbmFseXRpY3NNZXRhZGF0YV9JX1ZFUklGSUVEX1RISVNfSVNfTk9UX0NPREVfT1JfRklMRVBBVEhTLFxuICAgICAgLi4uKHN5c3RlbVByb21wdEZsYWcgJiYge1xuICAgICAgICBzeXN0ZW1Qcm9tcHRGbGFnOlxuICAgICAgICAgIHN5c3RlbVByb21wdEZsYWcgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIH0pLFxuICAgICAgLi4uKGFwcGVuZFN5c3RlbVByb21wdEZsYWcgJiYge1xuICAgICAgICBhcHBlbmRTeXN0ZW1Qcm9tcHRGbGFnOlxuICAgICAgICAgIGFwcGVuZFN5c3RlbVByb21wdEZsYWcgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIH0pLFxuICAgICAgaXNfc2ltcGxlOiBpc0JhcmVNb2RlKCkgfHwgdW5kZWZpbmVkLFxuICAgICAgaXNfY29vcmRpbmF0b3I6XG4gICAgICAgIGZlYXR1cmUoJ0NPT1JESU5BVE9SX01PREUnKSAmJlxuICAgICAgICBjb29yZGluYXRvck1vZGVNb2R1bGU/LmlzQ29vcmRpbmF0b3JNb2RlKClcbiAgICAgICAgICA/IHRydWVcbiAgICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICAgIC4uLihhc3Npc3RhbnRBY3RpdmF0aW9uUGF0aCAmJiB7XG4gICAgICAgIGFzc2lzdGFudEFjdGl2YXRpb25QYXRoOlxuICAgICAgICAgIGFzc2lzdGFudEFjdGl2YXRpb25QYXRoIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICB9KSxcbiAgICAgIGF1dG9VcGRhdGVzQ2hhbm5lbDogKGdldEluaXRpYWxTZXR0aW5ncygpLmF1dG9VcGRhdGVzQ2hhbm5lbCA/P1xuICAgICAgICAnbGF0ZXN0JykgYXMgQW5hbHl0aWNzTWV0YWRhdGFfSV9WRVJJRklFRF9USElTX0lTX05PVF9DT0RFX09SX0ZJTEVQQVRIUyxcbiAgICAgIC4uLihcImV4dGVybmFsXCIgPT09ICdhbnQnXG4gICAgICAgID8gKCgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGN3ZCA9IGdldEN3ZCgpXG4gICAgICAgICAgICBjb25zdCBnaXRSb290ID0gZmluZEdpdFJvb3QoY3dkKVxuICAgICAgICAgICAgY29uc3QgcnAgPSBnaXRSb290ID8gcmVsYXRpdmUoZ2l0Um9vdCwgY3dkKSB8fCAnLicgOiB1bmRlZmluZWRcbiAgICAgICAgICAgIHJldHVybiBycFxuICAgICAgICAgICAgICA/IHtcbiAgICAgICAgICAgICAgICAgIHJlbGF0aXZlUHJvamVjdFBhdGg6XG4gICAgICAgICAgICAgICAgICAgIHJwIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICA6IHt9XG4gICAgICAgICAgfSkoKVxuICAgICAgICA6IHt9KSxcbiAgICB9KVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGxvZ0Vycm9yKGVycm9yKVxuICB9XG59XG5cbmZ1bmN0aW9uIG1heWJlQWN0aXZhdGVQcm9hY3RpdmUob3B0aW9uczogdW5rbm93bik6IHZvaWQge1xuICBpZiAoXG4gICAgKGZlYXR1cmUoJ1BST0FDVElWRScpIHx8IGZlYXR1cmUoJ0tBSVJPUycpKSAmJlxuICAgICgob3B0aW9ucyBhcyB7IHByb2FjdGl2ZT86IGJvb2xlYW4gfSkucHJvYWN0aXZlIHx8XG4gICAgICBpc0VudlRydXRoeShwcm9jZXNzLmVudi5DTEFVREVfQ09ERV9QUk9BQ1RJVkUpKVxuICApIHtcbiAgICAvLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0c1xuICAgIGNvbnN0IHByb2FjdGl2ZU1vZHVsZSA9IHJlcXVpcmUoJy4vcHJvYWN0aXZlL2luZGV4LmpzJylcbiAgICBpZiAoIXByb2FjdGl2ZU1vZHVsZS5pc1Byb2FjdGl2ZUFjdGl2ZSgpKSB7XG4gICAgICBwcm9hY3RpdmVNb2R1bGUuYWN0aXZhdGVQcm9hY3RpdmUoJ2NvbW1hbmQnKVxuICAgIH1cbiAgfVxufVxuXG5mdW5jdGlvbiBtYXliZUFjdGl2YXRlQnJpZWYob3B0aW9uczogdW5rbm93bik6IHZvaWQge1xuICBpZiAoIShmZWF0dXJlKCdLQUlST1MnKSB8fCBmZWF0dXJlKCdLQUlST1NfQlJJRUYnKSkpIHJldHVyblxuICBjb25zdCBicmllZkZsYWcgPSAob3B0aW9ucyBhcyB7IGJyaWVmPzogYm9vbGVhbiB9KS5icmllZlxuICBjb25zdCBicmllZkVudiA9IGlzRW52VHJ1dGh5KHByb2Nlc3MuZW52LkNMQVVERV9DT0RFX0JSSUVGKVxuICBpZiAoIWJyaWVmRmxhZyAmJiAhYnJpZWZFbnYpIHJldHVyblxuICAvLyAtLWJyaWVmIC8gQ0xBVURFX0NPREVfQlJJRUYgYXJlIGV4cGxpY2l0IG9wdC1pbnM6IGNoZWNrIGVudGl0bGVtZW50LFxuICAvLyB0aGVuIHNldCB1c2VyTXNnT3B0SW4gdG8gYWN0aXZhdGUgdGhlIHRvb2wgKyBwcm9tcHQgc2VjdGlvbi4gVGhlIGVudlxuICAvLyB2YXIgYWxzbyBncmFudHMgZW50aXRsZW1lbnQgKGlzQnJpZWZFbnRpdGxlZCgpIHJlYWRzIGl0KSwgc28gc2V0dGluZ1xuICAvLyBDTEFVREVfQ09ERV9CUklFRj0xIGFsb25lIGZvcmNlLWVuYWJsZXMgZm9yIGRldi90ZXN0aW5nIFx1MjAxNCBubyBHQiBnYXRlXG4gIC8vIG5lZWRlZC4gaW5pdGlhbElzQnJpZWZPbmx5IHJlYWRzIGdldFVzZXJNc2dPcHRJbigpIGRpcmVjdGx5LlxuICAvLyBDb25kaXRpb25hbCByZXF1aXJlOiBzdGF0aWMgaW1wb3J0IHdvdWxkIGxlYWsgdGhlIHRvb2wgbmFtZSBzdHJpbmdcbiAgLy8gaW50byBleHRlcm5hbCBidWlsZHMgdmlhIEJyaWVmVG9vbC50cyBcdTIxOTIgcHJvbXB0LnRzLlxuICAvKiBlc2xpbnQtZGlzYWJsZSBAdHlwZXNjcmlwdC1lc2xpbnQvbm8tcmVxdWlyZS1pbXBvcnRzICovXG4gIGNvbnN0IHsgaXNCcmllZkVudGl0bGVkIH0gPVxuICAgIHJlcXVpcmUoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpIGFzIHR5cGVvZiBpbXBvcnQoJy4vdG9vbHMvQnJpZWZUb29sL0JyaWVmVG9vbC5qcycpXG4gIC8qIGVzbGludC1lbmFibGUgQHR5cGVzY3JpcHQtZXNsaW50L25vLXJlcXVpcmUtaW1wb3J0cyAqL1xuICBjb25zdCBlbnRpdGxlZCA9IGlzQnJpZWZFbnRpdGxlZCgpXG4gIGlmIChlbnRpdGxlZCkge1xuICAgIHNldFVzZXJNc2dPcHRJbih0cnVlKVxuICB9XG4gIC8vIEZpcmUgdW5jb25kaXRpb25hbGx5IG9uY2UgaW50ZW50IGlzIHNlZW46IGVuYWJsZWQ9ZmFsc2UgY2FwdHVyZXMgdGhlXG4gIC8vIFwidXNlciB0cmllZCBidXQgd2FzIGdhdGVkXCIgZmFpbHVyZSBtb2RlIGluIERhdGFkb2cuXG4gIGxvZ0V2ZW50KCd0ZW5ndV9icmllZl9tb2RlX2VuYWJsZWQnLCB7XG4gICAgZW5hYmxlZDogZW50aXRsZWQsXG4gICAgZ2F0ZWQ6ICFlbnRpdGxlZCxcbiAgICBzb3VyY2U6IChicmllZkVudlxuICAgICAgPyAnZW52J1xuICAgICAgOiAnZmxhZycpIGFzIEFuYWx5dGljc01ldGFkYXRhX0lfVkVSSUZJRURfVEhJU19JU19OT1RfQ09ERV9PUl9GSUxFUEFUSFMsXG4gIH0pXG59XG5cbmZ1bmN0aW9uIHJlc2V0Q3Vyc29yKCkge1xuICBjb25zdCB0ZXJtaW5hbCA9IHByb2Nlc3Muc3RkZXJyLmlzVFRZXG4gICAgPyBwcm9jZXNzLnN0ZGVyclxuICAgIDogcHJvY2Vzcy5zdGRvdXQuaXNUVFlcbiAgICAgID8gcHJvY2Vzcy5zdGRvdXRcbiAgICAgIDogdW5kZWZpbmVkXG4gIHRlcm1pbmFsPy53cml0ZShTSE9XX0NVUlNPUilcbn1cblxudHlwZSBUZWFtbWF0ZU9wdGlvbnMgPSB7XG4gIGFnZW50SWQ/OiBzdHJpbmdcbiAgYWdlbnROYW1lPzogc3RyaW5nXG4gIHRlYW1OYW1lPzogc3RyaW5nXG4gIGFnZW50Q29sb3I/OiBzdHJpbmdcbiAgcGxhbk1vZGVSZXF1aXJlZD86IGJvb2xlYW5cbiAgcGFyZW50U2Vzc2lvbklkPzogc3RyaW5nXG4gIHRlYW1tYXRlTW9kZT86ICdhdXRvJyB8ICd0bXV4JyB8ICdpbi1wcm9jZXNzJ1xuICBhZ2VudFR5cGU/OiBzdHJpbmdcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFRlYW1tYXRlT3B0aW9ucyhvcHRpb25zOiB1bmtub3duKTogVGVhbW1hdGVPcHRpb25zIHtcbiAgaWYgKHR5cGVvZiBvcHRpb25zICE9PSAnb2JqZWN0JyB8fCBvcHRpb25zID09PSBudWxsKSB7XG4gICAgcmV0dXJuIHt9XG4gIH1cbiAgY29uc3Qgb3B0cyA9IG9wdGlvbnMgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj5cbiAgY29uc3QgdGVhbW1hdGVNb2RlID0gb3B0cy50ZWFtbWF0ZU1vZGVcbiAgcmV0dXJuIHtcbiAgICBhZ2VudElkOiB0eXBlb2Ygb3B0cy5hZ2VudElkID09PSAnc3RyaW5nJyA/IG9wdHMuYWdlbnRJZCA6IHVuZGVmaW5lZCxcbiAgICBhZ2VudE5hbWU6IHR5cGVvZiBvcHRzLmFnZW50TmFtZSA9PT0gJ3N0cmluZycgPyBvcHRzLmFnZW50TmFtZSA6IHVuZGVmaW5lZCxcbiAgICB0ZWFtTmFtZTogdHlwZW9mIG9wdHMudGVhbU5hbWUgPT09ICdzdHJpbmcnID8gb3B0cy50ZWFtTmFtZSA6IHVuZGVmaW5lZCxcbiAgICBhZ2VudENvbG9yOlxuICAgICAgdHlwZW9mIG9wdHMuYWdlbnRDb2xvciA9PT0gJ3N0cmluZycgPyBvcHRzLmFnZW50Q29sb3IgOiB1bmRlZmluZWQsXG4gICAgcGxhbk1vZGVSZXF1aXJlZDpcbiAgICAgIHR5cGVvZiBvcHRzLnBsYW5Nb2RlUmVxdWlyZWQgPT09ICdib29sZWFuJ1xuICAgICAgICA/IG9wdHMucGxhbk1vZGVSZXF1aXJlZFxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICBwYXJlbnRTZXNzaW9uSWQ6XG4gICAgICB0eXBlb2Ygb3B0cy5wYXJlbnRTZXNzaW9uSWQgPT09ICdzdHJpbmcnXG4gICAgICAgID8gb3B0cy5wYXJlbnRTZXNzaW9uSWRcbiAgICAgICAgOiB1bmRlZmluZWQsXG4gICAgdGVhbW1hdGVNb2RlOlxuICAgICAgdGVhbW1hdGVNb2RlID09PSAnYXV0bycgfHxcbiAgICAgIHRlYW1tYXRlTW9kZSA9PT0gJ3RtdXgnIHx8XG4gICAgICB0ZWFtbWF0ZU1vZGUgPT09ICdpbi1wcm9jZXNzJ1xuICAgICAgICA/IHRlYW1tYXRlTW9kZVxuICAgICAgICA6IHVuZGVmaW5lZCxcbiAgICBhZ2VudFR5cGU6IHR5cGVvZiBvcHRzLmFnZW50VHlwZSA9PT0gJ3N0cmluZycgPyBvcHRzLmFn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