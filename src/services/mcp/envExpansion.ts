import { getProjectRoot } from '../../bootstrap/state.js'

/**
 * Shared utilities for expanding environment variables in server configurations
 */

export function getEnvExpansionExtraEnv(): Record<
  string,
  string | undefined
> {
  return { CLAUDE_PROJECT_DIR: getProjectRoot() }
}

/**
 * Expand environment variables in a string value.
 * Handles ${VAR} and ${VAR:-default} syntax. `extraEnv` takes precedence over
 * `process.env` for synthetic values like CLAUDE_PROJECT_DIR.
 */
export function expandEnvVarsInString(
  value: string,
  extraEnv: Record<string, string | undefined> = {},
): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    // Split on :- to support default values (limit to 2 parts to preserve :- in defaults)
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = extraEnv[varName] ?? process.env[varName]

    if (envValue !== undefined) {
      return envValue
    }
    if (defaultValue !== undefined) {
      return defaultValue
    }

    // Track missing variable for error reporting
    missingVars.push(varName)
    // Return original if not found (allows debugging but will be reported as error)
    return match
  })

  return {
    expanded,
    missingVars,
  }
}
