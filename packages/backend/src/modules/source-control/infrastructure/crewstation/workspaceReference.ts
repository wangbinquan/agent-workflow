const PREFIX = 'cs-workspace:'

/** References encode the owning AW task as well as its volume-relative path.
 * A container path alone is ambiguous because every task has its own /work. */
export function hostedWorkspaceReference(taskId: string, path: string): string {
  const relative = (path === '/work' ? '' : path.replace(/^\/work\//, '')).replace(/\/+$/, '')
  if (
    relative.startsWith('/') ||
    relative.split('/').some((part) => part === '..' || part === '.') ||
    relative.includes('\0') ||
    relative.includes('\\')
  ) {
    throw new Error('hosted-workspace-path-invalid')
  }
  return `${PREFIX}${encodeURIComponent(taskId)}/${relative}`
}

export function parseHostedWorkspaceReference(reference: string): {
  taskId: string
  path: string
  relative: string
} {
  if (!reference.startsWith(PREFIX)) throw new Error('hosted-workspace-reference-required')
  const slash = reference.indexOf('/', PREFIX.length)
  if (slash === -1) throw new Error('hosted-workspace-reference-invalid')
  const taskId = decodeURIComponent(reference.slice(PREFIX.length, slash))
  const relative = reference.slice(slash + 1)
  if (
    taskId.length === 0 ||
    relative.startsWith('/') ||
    relative.split('/').some((part) => part === '..' || part === '.') ||
    relative.includes('\0') ||
    relative.includes('\\')
  ) {
    throw new Error('hosted-workspace-reference-invalid')
  }
  return { taskId, relative, path: relative === '' ? '/work' : `/work/${relative}` }
}

/** Translates the named references of one whole-volume operation to volume
 * paths. Every reference must name the same volume owner. */
export function hostedVolumePaths<const K extends string>(
  references: Readonly<Record<K, string>>,
): { readonly owner: string; readonly paths: Record<K, string> } {
  let owner: string | undefined
  const paths = {} as Record<K, string>
  for (const [key, reference] of Object.entries(references) as [K, string][]) {
    const location = parseHostedWorkspaceReference(reference)
    if (owner !== undefined && location.taskId !== owner)
      throw new Error('hosted-workspace-volume-mismatch')
    owner = location.taskId
    paths[key] = location.path
  }
  if (owner === undefined) throw new Error('hosted-workspace-reference-required')
  return { owner, paths }
}

export function joinHostedWorkspaceReference(reference: string, relative: string): string {
  const workspace = parseHostedWorkspaceReference(reference)
  return hostedWorkspaceReference(workspace.taskId, `${workspace.path}/${relative}`)
}
