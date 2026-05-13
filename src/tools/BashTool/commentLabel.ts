/**
 * If the first line of a bash command is a `# comment` (not a `#!` shebang),
 * return the comment text stripped of the `#` prefix. Otherwise undefined.
 *
 * Under fullscreen mode this is the non-verbose tool-use label AND the
 * collapse-group ⎿ hint — it's what Claude wrote for the human to read.
 *
 * SECURITY: When the command has additional non-empty lines after the comment,
 * return undefined so the renderer shows the full multi-line command. A leading
 * `# Looks safe` followed by `rm -rf ~/` would otherwise present only the
 * reassuring label, hiding the actual command (UI-spoofing vector, fixed in
 * upstream 2.1.113).
 */
export function extractBashCommentLabel(command: string): string | undefined {
  const nl = command.indexOf('\n')
  const firstLine = (nl === -1 ? command : command.slice(0, nl)).trim()
  if (!firstLine.startsWith('#') || firstLine.startsWith('#!')) return undefined
  if (nl !== -1 && command.slice(nl + 1).trim().length > 0) return undefined
  return firstLine.replace(/^#+\s*/, '') || undefined
}
