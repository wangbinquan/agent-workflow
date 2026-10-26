/** A mount is relative to the recorded workspace, independently of the SQL provider. */
export function taskMountWorktreePath(root: string | null, mountPath: string): string {
  if (root === null) return ''
  if (mountPath === '') return root
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return root.replace(/[/\\]+$/u, '') + separator + mountPath.split('/').join(separator)
}
