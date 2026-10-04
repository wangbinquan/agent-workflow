export function repoRelForcedPaths(
  containerPaths: readonly string[] | undefined,
  worktreeDirName: string,
): string[] {
  if (containerPaths === undefined || containerPaths.length === 0) return []
  if (worktreeDirName === '') return [...containerPaths]
  const prefix = worktreeDirName + '/'
  return containerPaths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
}
