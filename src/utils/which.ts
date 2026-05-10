import { execFileSync } from 'child_process'
import { execa } from 'execa'

function isInvalidCommandName(command: string): boolean {
  return command.length === 0 || command.includes('\0') || /[\r\n]/.test(command)
}

async function whichNodeAsync(command: string): Promise<string | null> {
  if (isInvalidCommandName(command)) return null

  const bin = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await execa(bin, [command], {
    shell: false,
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  return result.stdout.trim().split(/\r?\n/)[0] || null
}

function whichNodeSync(command: string): string | null {
  if (isInvalidCommandName(command)) return null

  const bin = process.platform === 'win32' ? 'where.exe' : 'which'
  try {
    const result = execFileSync(bin, [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return result.toString().trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which
    : null

/**
 * Finds the full path to a command executable.
 * Uses Bun.which when running in Bun (fast, no process spawn),
 * otherwise spawns the platform-appropriate command.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => (isInvalidCommandName(command) ? null : bunWhich(command))
  : whichNodeAsync

/**
 * Synchronous version of `which`.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const whichSync: (command: string) => string | null = bunWhich
  ? command => (isInvalidCommandName(command) ? null : bunWhich(command))
  : whichNodeSync
