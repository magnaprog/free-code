/**
 * Shared utilities for expanding environment variables in MCP server configurations
 */

/**
 * Expand environment variables in a string value.
 * Handles ${VAR} and ${VAR:-default} syntax.
 *
 * `extraEnv` provides synthetic values for variables the user is unlikely
 * to set themselves (notably CLAUDE_PROJECT_DIR for MCP server config).
 * Entries in `extraEnv` take precedence over `process.env`, matching how
 * hooks receive these variables — `getProjectRoot()` is the stable project
 * root and should win over any inherited shell var of the same name.
 *
 * @returns Object with expanded string and list of missing variables
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
